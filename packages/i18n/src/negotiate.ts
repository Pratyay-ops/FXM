/**
 * Which locale to show: the user's choice in Settings, else the first of the browser's languages
 * FXM has messages for, else English. Also the locale to format with, the text direction, and the
 * locales a catalog falls back through.
 *
 * Matching uses `Intl.Locale`'s likely subtags, so scripts are respected: `zh-TW` and `zh-HK`
 * get Traditional Chinese (`zh-Hant`), `zh` and `zh-SG` Simplified (`zh-Hans`), and `sr-Latn`
 * never falls back to Cyrillic `sr`. A region only picks between catalogs of one language, by the
 * region asked for or else the one likely for the language, whatever the catalogs' order:
 * `pt-PT` takes `pt-PT`, else `pt`, else `pt-BR`; a bare `pt` takes `pt-BR` and `es` takes
 * `es-ES`. Varieties that stand for several regions, such as Latin American Spanish (`es-419`)
 * for `es-MX`, need CLDR's parent locales, which come with the first such catalog
 * (docs/I18N.md, "Adding a language").
 *
 * @module
 */

/** Text direction, as the `dir` attribute takes it. */
export type Direction = 'ltr' | 'rtl'

/** The locale FXM shows, and how it formats. */
export interface LocaleChoice {
  /** The locale whose messages FXM shows: one of the available locales. */
  readonly locale: string
  /**
   * The locale numbers, dates and lists are formatted in: the user's own tag when it is the same
   * language and script as {@link locale} (`en-IN` keeps Indian digit grouping with the `en`
   * messages), else {@link locale}.
   */
  readonly formatLocale: string
  /** The direction of {@link locale}'s script. */
  readonly direction: Direction
}

/** What {@link negotiateLocale} chooses from. */
export interface NegotiateOptions {
  /** Locales with messages, the source locale included, in the order a language picker lists them. */
  readonly available: readonly string[]
  /** The locale when nothing else matches: the source locale, `en`. */
  readonly defaultLocale: string
  /** The browser's languages, most preferred first (`requestedLocales()`). */
  readonly requested?: readonly string[]
  /**
   * The language chosen in Settings, which wins when available; `undefined` follows the browser.
   * Pseudo-locales are chosen only this way: no browser asks for them.
   */
  readonly preference?: string | undefined
}

/** Scripts written right to left, by their ISO 15924 codes. */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  'Adlm',
  'Arab',
  'Hebr',
  'Mand',
  'Mend',
  'Nkoo',
  'Rohg',
  'Samr',
  'Syrc',
  'Thaa',
  'Yezi',
])

/** `tag` as an `Intl.Locale` in canonical form, or `undefined` if it isn't a valid tag. */
function parseTag(tag: string): Intl.Locale | undefined {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag)
    return canonical === undefined ? undefined : new Intl.Locale(canonical)
  } catch {
    return undefined
  }
}

/** Whether two locales share a language and script once their likely subtags are filled in. */
function sameLanguage(a: Intl.Locale, b: Intl.Locale): boolean {
  const left = a.maximize()
  const right = b.maximize()
  return left.language === right.language && left.script === right.script
}

/**
 * The direction `locale` is written in, from its script (filled in from likely subtags, so `ar`,
 * `he`, `fa`, `ur` and `ckb` are right to left, and `ar-XB` too). Invalid tags are `ltr`.
 */
export function textDirection(locale: string): Direction {
  const tag = parseTag(locale)
  return tag !== undefined && RTL_SCRIPTS.has(tag.maximize().script ?? '') ? 'rtl' : 'ltr'
}

/**
 * The browser's languages, most preferred first: `navigator.languages`, else
 * `navigator.language`, else none (outside a browser).
 */
export function requestedLocales(
  from: { readonly languages?: readonly string[]; readonly language?: string } | undefined = (
    globalThis as { navigator?: { languages?: readonly string[]; language?: string } }
  ).navigator,
): string[] {
  const languages = from?.languages?.filter((tag) => typeof tag === 'string' && tag !== '')
  if (languages !== undefined && languages.length > 0) return [...languages]
  return from?.language ? [from.language] : []
}

/** The best of `available` for `wanted`, or `undefined`: see the module's notes. */
function match(wanted: Intl.Locale, available: readonly Intl.Locale[]): Intl.Locale | undefined {
  const exact = available.find((tag) => tag.toString() === wanted.toString())
  if (exact !== undefined) return exact
  const candidates = available.filter((tag) => sameLanguage(tag, wanted))
  // The region asked for, else the one likely for the language: `pt` is Brazil's, `es` Spain's.
  const region = wanted.region ?? wanted.maximize().region
  return (
    candidates.find((tag) => tag.region === region) ??
    candidates.find((tag) => tag.region === undefined && tag.maximize().region === region) ??
    candidates.find((tag) => tag.region === undefined) ??
    // The language's main variety, es-ES for es-AR, rather than the first in the list.
    candidates.find((tag) => tag.minimize().region === undefined) ??
    candidates[0]
  )
}

/** Chooses the locale to show and to format with: see {@link LocaleChoice}. */
export function negotiateLocale(options: NegotiateOptions): LocaleChoice {
  const available = options.available.flatMap((tag) => parseTag(tag) ?? [])
  const requested = (options.requested ?? []).flatMap((tag) => parseTag(tag) ?? [])
  const choose = (locale: Intl.Locale, formatWith: Intl.Locale | undefined): LocaleChoice => {
    const tag = locale.toString()
    return {
      locale: tag,
      formatLocale:
        formatWith !== undefined && sameLanguage(formatWith, locale) ? formatWith.toString() : tag,
      direction: textDirection(tag),
    }
  }

  const preferred = options.preference === undefined ? undefined : parseTag(options.preference)
  const chosen =
    preferred === undefined
      ? undefined
      : available.find((tag) => tag.toString() === preferred.toString())
  if (chosen !== undefined) {
    return choose(
      chosen,
      requested.find((tag) => sameLanguage(tag, chosen)),
    )
  }
  for (const wanted of requested) {
    const found = match(wanted, available)
    if (found !== undefined) return choose(found, wanted)
  }
  const fallback = parseTag(options.defaultLocale)
  return fallback === undefined
    ? { locale: options.defaultLocale, formatLocale: options.defaultLocale, direction: 'ltr' }
    : choose(fallback, undefined)
}

/**
 * The locales whose messages `locale` may use, most specific first, by dropping subtags while the
 * script stays the same: `pt-BR` is `[pt-BR, pt]`, `zh-Hant-TW` is `[zh-Hant-TW, zh-Hant]`
 * (`zh` alone means Simplified Chinese, so it isn't a fallback for Traditional).
 */
export function fallbackChain(locale: string): string[] {
  const tag = parseTag(locale)
  if (tag === undefined) return [locale]
  const chain: string[] = []
  const subtags = tag.toString().split('-')
  const script = tag.maximize().script
  for (let length = subtags.length; length > 0; length -= 1) {
    const candidate = parseTag(subtags.slice(0, length).join('-'))
    if (candidate !== undefined && candidate.maximize().script === script) {
      const text = candidate.toString()
      if (!chain.includes(text)) chain.push(text)
    }
  }
  return chain
}

/** Sets `lang` and `dir` on `element`, the document's `<html>` by default. */
export function applyDocumentLocale(
  choice: Pick<LocaleChoice, 'locale' | 'direction'>,
  element: { setAttribute(name: string, value: string): void } | undefined = (
    globalThis as {
      document?: { documentElement: { setAttribute(name: string, value: string): void } }
    }
  ).document?.documentElement,
): void {
  element?.setAttribute('lang', choice.locale)
  element?.setAttribute('dir', choice.direction)
}
