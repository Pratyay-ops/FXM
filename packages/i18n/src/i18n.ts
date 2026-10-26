/**
 * An app's translations: the current locale, the catalogs loaded for it, and translators that
 * look messages up by namespace and key.
 *
 * English, the source locale, needs no catalog: it is the namespaces' own messages, bundled with
 * the code that uses them. Other locales load their catalog when the app switches to them
 * (`setLocale`), through the app's `load`, typically a lazy `import()` of one chunk per locale.
 * A message a catalog lacks, or leaves empty (as translation platforms write the ones nobody has
 * translated yet), falls back along the locale's chain (`pt-BR`, then `pt`), then to English,
 * and is reported once through `onMissing`. A translation that can't be read (bad
 * syntax) is reported through `onError` and English is shown instead; a value a message needs but
 * doesn't get shows as `{name}`, also reported.
 *
 * Nothing here is global: the app creates one instance and hands it to React (`I18nProvider`) and
 * to code outside components, so tests can make their own.
 *
 * @module
 */

import { formatToParts, formatToString, type ValueProblem, type Values } from './format'
import type { AnyValues, MessageKey, Messages, Namespace, RichValues, ValuesArg } from './messages'
import { type Direction, fallbackChain, textDirection } from './negotiate'
import { type MessageNode, parseMessage } from './parse'

/** A locale's translations: namespace, then key, then message. */
export type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>

/**
 * Makes a locale's messages from the source locale's parsed messages instead of loading them: a
 * pseudo-locale (`@fxm/i18n/pseudo`).
 */
export type DeriveMessages = (nodes: readonly MessageNode[]) => MessageNode[]

/** A message the current locale has no translation for. */
export interface MissingMessage {
  readonly locale: string
  readonly namespace: string
  readonly key: string
}

/** A message that couldn't be formatted as written. */
export interface MessageProblem {
  readonly locale: string
  readonly namespace: string
  readonly key: string
  /** What went wrong: a syntax error's text, or a value problem. */
  readonly problem: string
}

/** How to create an {@link I18n}. */
export interface I18nOptions {
  /** The locale the namespaces' own messages are in. Default: `en`. */
  readonly sourceLocale?: string
  /**
   * Locales with catalogs, besides the source locale, for `load`. Like every tag here, they are
   * kept in canonical form (`pt-br` is `pt-BR`), so negotiation's choice always matches one.
   */
  readonly locales?: readonly string[]
  /**
   * Loads a locale's catalog, given its canonical tag; called once per locale, on the first switch
   * to it or `load`.
   */
  readonly load?: (locale: string) => Promise<Catalog>
  /** Locales made from the source messages rather than loaded: the pseudo-locales. */
  readonly derived?: Readonly<Record<string, DeriveMessages>>
  /**
   * The locale to start in. Default: the source locale. Until its catalog is added (`addCatalog`)
   * it shows English, so an app negotiates first and switches with `setLocale`, which loads.
   */
  readonly locale?: string
  /** The locale to format in. Default: {@link locale}. */
  readonly formatLocale?: string
  /** Told once about each message a locale lacks. In development, log it. */
  readonly onMissing?: (missing: MissingMessage) => void
  /** Told about each message that couldn't be formatted as written. In development, log it. */
  readonly onError?: (problem: MessageProblem) => void
}

/** Translates the keys of one namespace in the current locale. */
export interface Translator<M extends Messages> {
  /** The message `key` with `values`, as text. Tags keep only their content. */
  <K extends MessageKey<M>>(key: K, ...values: ValuesArg<M[K]>): string
  /**
   * The message `key` with its tags rendered: `values` holds the message's values and a function
   * per tag, which gets the tag's formatted content. Returns the parts: text and what the
   * functions return. `@fxm/i18n/react`'s translators wrap this for React elements.
   */
  rich<K extends MessageKey<M>, T>(
    key: K,
    values: RichValues<M[K], (string | T)[], T>,
  ): (string | T)[]
  /** The namespace it translates. */
  readonly namespace: Namespace<M>
}

/** An app's translations. */
export interface I18n {
  /** The locale of the namespaces' own messages. */
  readonly sourceLocale: string
  /**
   * Every locale it can show, in canonical form: the source locale, the catalog locales, the
   * derived ones.
   */
  readonly locales: readonly string[]
  /** The locale whose messages it shows. */
  readonly locale: string
  /** The locale it formats numbers, dates and lists in. */
  readonly formatLocale: string
  /** The direction of {@link locale}'s script. */
  readonly direction: Direction
  /** Changes whenever what it shows changes: the locale, or a catalog added for it. */
  readonly revision: number
  /**
   * Switches to `locale` (one of {@link locales}, in any spelling: `pt-br` is `pt-BR`) once its
   * catalogs are loaded, and formats in `formatLocale` (default: `locale`). A later call wins
   * over an earlier one still loading. Rejects, staying in the current locale, when a catalog
   * fails to load.
   */
  setLocale(locale: string, formatLocale?: string): Promise<void>
  /** Loads `locale`'s catalogs without switching to it, for instance while Settings is open. */
  load(locale: string): Promise<void>
  /** Adds translations for `locale`, merged over what it has: preloaded catalogs and tests. */
  addCatalog(locale: string, catalog: Catalog): void
  /** A translator for `namespace`, which always speaks the current locale. */
  translator<M extends Messages>(namespace: Namespace<M>): Translator<M>
  /** Calls `listener` after every change of {@link revision}. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Parsed messages, by text: the same text parses the same everywhere. */
const parsed = new Map<string, MessageNode[] | Error>()

function parseCached(message: string): MessageNode[] | Error {
  let nodes = parsed.get(message)
  if (nodes === undefined) {
    try {
      nodes = parseMessage(message)
    } catch (error) {
      nodes = error instanceof Error ? error : new Error(String(error))
    }
    parsed.set(message, nodes)
  }
  return nodes
}

/** `tag` in canonical form (`pt-br` is `pt-BR`), or as it is when it isn't a valid tag. */
function canonical(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? tag
  } catch {
    return tag
  }
}

/** Creates an app's translations. */
export function createI18n(options: I18nOptions = {}): I18n {
  const sourceLocale = canonical(options.sourceLocale ?? 'en')
  const derived = new Map(
    Object.entries(options.derived ?? {}).map(([tag, derive]) => [canonical(tag), derive]),
  )
  const locales = [
    ...new Set([sourceLocale, ...(options.locales ?? []).map(canonical), ...derived.keys()]),
  ]
  const catalogs = new Map<string, Record<string, Record<string, string>>>()
  const loading = new Map<string, Promise<void>>()
  const derivedNodes = new Map<string, MessageNode[]>()
  const reported = new Set<string>()
  const listeners = new Set<() => void>()
  let locale = canonical(options.locale ?? sourceLocale)
  let formatLocale = options.formatLocale ?? locale
  let direction = textDirection(locale)
  let revision = 0
  let switching = 0

  /** `tag` as one of {@link locales}; throws when it isn't one. */
  const known = (tag: string): string => {
    const found = canonical(tag)
    if (!locales.includes(found)) throw new RangeError(`${tag} is not one of ${locales.join(', ')}`)
    return found
  }
  known(locale)

  /** The catalog locales `tag` reads messages from, most specific first. */
  const chainOf = (tag: string): string[] =>
    fallbackChain(tag).filter(
      (link) => link !== sourceLocale && locales.includes(link) && !derived.has(link),
    )

  const changed = (): void => {
    revision += 1
    for (const listener of [...listeners]) listener()
  }

  const addCatalog = (given: string, catalog: Catalog): void => {
    const tag = canonical(given)
    const target = catalogs.get(tag) ?? {}
    for (const [namespace, messages] of Object.entries(catalog)) {
      target[namespace] = { ...target[namespace], ...messages }
    }
    catalogs.set(tag, target)
    if (chainOf(locale).includes(tag)) changed()
  }

  const loadOne = (tag: string): Promise<void> => {
    if (catalogs.has(tag)) return Promise.resolve()
    let pending = loading.get(tag)
    if (pending === undefined) {
      const load = options.load
      pending =
        load === undefined
          ? Promise.reject(new Error(`No catalog loader for ${tag}`))
          : load(tag).then((catalog) => addCatalog(tag, catalog))
      // A failed load may be retried later.
      pending.catch(() => loading.delete(tag))
      loading.set(tag, pending)
    }
    return pending
  }

  const load = async (tag: string): Promise<void> => {
    await Promise.all(chainOf(known(tag)).map(loadOne))
  }

  const report = (key: string, notify: () => void): void => {
    if (reported.has(key)) return
    reported.add(key)
    notify()
  }

  /** The parsed message to show for `namespace.key` in the current locale. */
  const lookup = <M extends Messages>(namespace: Namespace<M>, key: string): MessageNode[] => {
    const name = namespace.name
    const id = `${name}.${key}`
    const problem = (where: string, text: string): void =>
      report(`${where}|${id}|${text}`, () =>
        options.onError?.({ locale: where, namespace: name, key, problem: text }),
      )
    const source = Object.hasOwn(namespace.messages, key) ? namespace.messages[key] : undefined
    if (source === undefined) {
      problem(sourceLocale, `No message ${id} in the source locale`)
      return [`${id}`]
    }
    const derive = derived.get(locale)
    for (const tag of derive === undefined ? chainOf(locale) : []) {
      const messages = catalogs.get(tag)?.[name]
      const message =
        messages !== undefined && Object.hasOwn(messages, key) ? messages[key] : undefined
      // An empty message is one nobody has translated yet, unless the English is empty too.
      if (message === undefined || (message === '' && source !== '')) continue
      const nodes = parseCached(message)
      if (!(nodes instanceof Error)) return nodes
      problem(tag, nodes.message)
      break
    }
    const nodes = parseCached(source)
    if (nodes instanceof Error) {
      problem(sourceLocale, nodes.message)
      return [source]
    }
    if (derive !== undefined) {
      const cacheKey = `${locale}|${source}`
      let made = derivedNodes.get(cacheKey)
      if (made === undefined) {
        made = derive(nodes)
        derivedNodes.set(cacheKey, made)
      }
      return made
    }
    if (locale !== sourceLocale) {
      report(`missing|${locale}|${id}`, () => options.onMissing?.({ locale, namespace: name, key }))
    }
    return nodes
  }

  const valueProblems = (name: string, key: string) => (problem: ValueProblem) =>
    report(`value|${locale}|${name}.${key}|${problem.kind}|${problem.name}`, () =>
      options.onError?.({
        locale,
        namespace: name,
        key,
        problem: `${problem.kind === 'missing' ? 'No value' : 'A value of the wrong kind'} for {${problem.name}}`,
      }),
    )

  const translator = <M extends Messages>(namespace: Namespace<M>): Translator<M> => {
    const translate = (key: string, values?: AnyValues): string =>
      formatToString(lookup(namespace, key), {
        locale: formatLocale,
        values: values as Values | undefined,
        onProblem: valueProblems(namespace.name, key),
      })
    const rich = <T>(key: string, values: AnyValues): (string | T)[] =>
      formatToParts<T>(lookup(namespace, key), {
        locale: formatLocale,
        values: values as Values,
        tag: (name, children) => {
          const render = values[name]
          if (typeof render === 'function') return render(children) as T
          valueProblems(namespace.name, key)({ kind: 'missing', name })
          return undefined
        },
        onProblem: valueProblems(namespace.name, key),
      })
    return Object.assign(translate, { rich, namespace }) as unknown as Translator<M>
  }

  return {
    sourceLocale,
    locales,
    get locale() {
      return locale
    },
    get formatLocale() {
      return formatLocale
    },
    get direction() {
      return direction
    },
    get revision() {
      return revision
    },
    async setLocale(tag, formatTag) {
      const target = known(tag)
      const ticket = ++switching
      await load(target)
      if (ticket !== switching) return
      const format = formatTag ?? target
      if (target === locale && format === formatLocale) return
      locale = target
      formatLocale = format
      direction = textDirection(locale)
      changed()
    },
    load,
    addCatalog,
    translator,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
