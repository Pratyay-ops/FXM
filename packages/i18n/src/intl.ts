/**
 * Formatting through the platform's `Intl`: numbers, sizes, durations, dates, times, relative
 * times, lists, language names and sorting, for one locale. FXM ships no locale data of its own:
 * every browser FXM supports has these APIs and CLDR's data for them.
 *
 * Creating an `Intl` formatter costs far more than using one, so each is made once per locale
 * and options and kept (`numberFormat` and friends), which also makes them cheap to call from
 * render functions.
 *
 * `Intl.DurationFormat` is not used: Node 22, which runs the tests, lacks it, and so did Firefox
 * before 136. Durations are built from unit-formatted numbers and a unit list instead, which
 * gives the same text in the locales checked (see the tests).
 *
 * @module
 */

const cache = new Map<string, unknown>()

/** The formatter for `key`, made by `create` the first time. */
function memo<T>(key: string, create: () => T): T {
  let value = cache.get(key) as T | undefined
  if (value === undefined) {
    value = create()
    cache.set(key, value)
  }
  return value
}

const keyOf = (kind: string, locale: string, options: object | undefined): string =>
  `${kind}|${locale}|${options === undefined ? '' : JSON.stringify(options)}`

/** A cached `Intl.NumberFormat`. */
export function numberFormat(
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  return memo(keyOf('n', locale, options), () => new Intl.NumberFormat(locale, options))
}

/** A cached `Intl.PluralRules`. */
export function pluralRules(
  locale: string,
  type: Intl.PluralRuleType = 'cardinal',
): Intl.PluralRules {
  return memo(keyOf('p', locale, { type }), () => new Intl.PluralRules(locale, { type }))
}

/** A cached `Intl.DateTimeFormat`. */
export function dateTimeFormat(
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return memo(keyOf('d', locale, options), () => new Intl.DateTimeFormat(locale, options))
}

/** A cached `Intl.RelativeTimeFormat`. */
export function relativeTimeFormat(
  locale: string,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  return memo(keyOf('r', locale, options), () => new Intl.RelativeTimeFormat(locale, options))
}

/** A cached `Intl.ListFormat`. */
export function listFormat(locale: string, options?: Intl.ListFormatOptions): Intl.ListFormat {
  return memo(keyOf('l', locale, options), () => new Intl.ListFormat(locale, options))
}

/** A cached `Intl.DisplayNames`. */
export function displayNames(locale: string, options: Intl.DisplayNamesOptions): Intl.DisplayNames {
  return memo(keyOf('dn', locale, options), () => new Intl.DisplayNames(locale, options))
}

/** A cached `Intl.Collator`. */
export function collator(locale: string, options?: Intl.CollatorOptions): Intl.Collator {
  return memo(keyOf('c', locale, options), () => new Intl.Collator(locale, options))
}

/** How {@link Formatters.duration} writes a length of time. */
export type DurationStyle =
  /** A clock: `3:07`, `1:02:03`, as a player shows a position or a track's length. */
  | 'digital'
  /** Words: `1 hour, 5 minutes`. */
  | 'long'
  /** Abbreviations: `1 hr 5 min`. */
  | 'short'
  /** As short as the locale writes it: `1h 5m`. */
  | 'narrow'

/** The date and time styles of `Intl.DateTimeFormat`. */
export type DateTimeStyle = 'short' | 'medium' | 'long' | 'full'

/**
 * Formatting for one locale (`createFormatters`). Each method is also a function of its own that
 * takes the locale first (`formatDuration(locale, 125)`), which bundles only what a chunk uses.
 */
export interface Formatters {
  /** The locale it formats for. */
  readonly locale: string
  /** `1,234.5` in `en`, `1.234,5` in `de`. */
  number(value: number, options?: Intl.NumberFormatOptions): string
  /** A fraction as a percentage: `0.42` is `42%`. */
  percent(fraction: number, options?: Intl.NumberFormatOptions): string
  /**
   * A size in decimal units, as the operating systems show them: `512 bytes`, `4.2 MB`, `31 GB`,
   * with one decimal below 10. Nothing, a negative or an invalid size is `0 bytes`.
   */
  bytes(bytes: number): string
  /**
   * A length of time in seconds (see {@link DurationStyle}). In words it keeps the two largest
   * units that matter: hours and minutes from an hour (seconds dropped, minutes rounded), minutes
   * from a minute, else seconds. Negative or invalid input is no time at all: `0:00`, `0 seconds`.
   */
  duration(seconds: number, style?: DurationStyle): string
  /** A date: `Oct 26, 2026` (`medium`, the default) in `en-US`, `26 Oct 2026` in `en-GB`. */
  date(value: Date | number, style?: DateTimeStyle | Intl.DateTimeFormatOptions): string
  /** A time of day: `5:30 PM` (`short`, the default) in `en-US`, `17:30` in `de`. */
  time(value: Date | number, style?: DateTimeStyle): string
  /** `in 3 days`, `yesterday`: a relative time in a unit of your choice. */
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string
  /**
   * How long ago (or how far ahead) `value` is from `now`, in the largest unit that fits:
   * `now`, `5 minutes ago`, `3 hours ago`, `yesterday`, `last week`, `in 2 months`. A day is 24
   * hours here; for calendar days ("today" since midnight), count them and use
   * {@link Formatters.relativeTime}.
   */
  timeAgo(value: Date | number, now?: Date | number): string
  /** `a, b and c` (`conjunction`, the default), `a, b or c` (`disjunction`) or a unit list. */
  list(items: readonly string[], type?: Intl.ListFormatType, style?: Intl.ListFormatStyle): string
  /** A language's name in this locale: `German` for `de` in `en`. The tag itself if unknown. */
  languageName(tag: string): string
  /** Compares two strings for sorting in this locale: numbers by value, ignoring case and accents. */
  compare(a: string, b: string): number
}

const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte'] as const

/** The steps of {@link formatTimeAgo}: a unit, and how many of it make the next one. */
const TIME_AGO_STEPS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 365.2425 / 12 / 7],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

const timeOf = (value: Date | number): number =>
  typeof value === 'number' ? value : value.getTime()

/** See {@link Formatters.number}. */
export function formatNumber(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormat(locale, options).format(value)
}

/** See {@link Formatters.percent}. */
export function formatPercent(
  locale: string,
  fraction: number,
  options?: Intl.NumberFormatOptions,
): string {
  return formatNumber(locale, fraction, { style: 'percent', ...options })
}

const formatUnit = (
  locale: string,
  value: number,
  unit: string,
  unitDisplay: Intl.NumberFormatOptions['unitDisplay'],
): string => formatNumber(locale, value, { style: 'unit', unit, unitDisplay })

/** See {@link Formatters.bytes}. */
export function formatBytes(locale: string, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) {
    return formatUnit(
      locale,
      Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0,
      'byte',
      'long',
    )
  }
  let value = bytes / 1000
  let index = 0
  while (value >= 1000 && index < BYTE_UNITS.length - 1) {
    value /= 1000
    index += 1
  }
  return formatNumber(locale, value, {
    style: 'unit',
    unit: BYTE_UNITS[index],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 ? 1 : 0,
  })
}

/** See {@link Formatters.list}. */
export function formatList(
  locale: string,
  items: readonly string[],
  type: Intl.ListFormatType = 'conjunction',
  style: Intl.ListFormatStyle = 'long',
): string {
  return listFormat(locale, { type, style }).format(items)
}

/** See {@link Formatters.duration}. */
export function formatDuration(
  locale: string,
  seconds: number,
  style: DurationStyle = 'digital',
): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  if (style === 'digital') {
    const pad = (value: number) =>
      formatNumber(locale, value, { minimumIntegerDigits: 2, useGrouping: false })
    const plain = (value: number) => formatNumber(locale, value, { useGrouping: false })
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const rest = pad(whole % 60)
    return hours > 0 ? `${plain(hours)}:${pad(minutes)}:${rest}` : `${plain(minutes)}:${rest}`
  }
  const parts: string[] = []
  if (whole < 60) parts.push(formatUnit(locale, whole, 'second', style))
  else {
    const minutes = Math.round(whole / 60)
    const hours = Math.floor(minutes / 60)
    if (hours > 0) parts.push(formatUnit(locale, hours, 'hour', style))
    if (hours === 0 || minutes % 60 > 0)
      parts.push(formatUnit(locale, minutes % 60, 'minute', style))
  }
  // "1 hr 5 min" reads best with the narrow list's spaces; long words take the long list.
  return formatList(locale, parts, 'unit', style === 'long' ? 'long' : 'narrow')
}

/** See {@link Formatters.date}. */
export function formatDate(
  locale: string,
  value: Date | number,
  style: DateTimeStyle | Intl.DateTimeFormatOptions = 'medium',
): string {
  return dateTimeFormat(locale, typeof style === 'string' ? { dateStyle: style } : style).format(
    value,
  )
}

/** See {@link Formatters.time}. */
export function formatTime(
  locale: string,
  value: Date | number,
  style: DateTimeStyle = 'short',
): string {
  return dateTimeFormat(locale, { timeStyle: style }).format(value)
}

/** See {@link Formatters.relativeTime}. */
export function formatRelativeTime(
  locale: string,
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
): string {
  return relativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit)
}

/** See {@link Formatters.timeAgo}. */
export function formatTimeAgo(
  locale: string,
  value: Date | number,
  now: Date | number = Date.now(),
): string {
  // Halves round away from zero, the same both ways: 90 seconds ago is 2 minutes ago.
  const rounded = (amount: number) => Math.sign(amount) * Math.round(Math.abs(amount))
  let delta = (timeOf(value) - timeOf(now)) / 1000
  for (const [unit, size] of TIME_AGO_STEPS) {
    if (Math.abs(delta) < size) return formatRelativeTime(locale, rounded(delta), unit)
    delta /= size
  }
  // Unreachable: the last step is infinite.
  return formatRelativeTime(locale, rounded(delta), 'year')
}

/** See {@link Formatters.languageName}. */
export function languageName(locale: string, tag: string): string {
  try {
    return displayNames(locale, { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/** A language's name in that language, for a language picker: `Deutsch` for `de`. */
export function autonym(tag: string): string {
  return languageName(tag, tag)
}

/** See {@link Formatters.compare}. */
export function compareText(locale: string, a: string, b: string): number {
  return collator(locale, { numeric: true, sensitivity: 'base' }).compare(a, b)
}

const formatters = new Map<string, Formatters>()

/**
 * All the formatters of `locale`, made once per locale. Handy, but it takes every formatter into
 * the bundle; code in the first load imports the functions it uses (`formatDuration`) instead.
 */
export function createFormatters(locale: string): Formatters {
  let made = formatters.get(locale)
  if (made === undefined) {
    made = {
      locale,
      number: (value, options) => formatNumber(locale, value, options),
      percent: (fraction, options) => formatPercent(locale, fraction, options),
      bytes: (bytes) => formatBytes(locale, bytes),
      duration: (seconds, style) => formatDuration(locale, seconds, style),
      date: (value, style) => formatDate(locale, value, style),
      time: (value, style) => formatTime(locale, value, style),
      relativeTime: (value, unit) => formatRelativeTime(locale, value, unit),
      timeAgo: (value, now) => formatTimeAgo(locale, value, now),
      list: (items, type, style) => formatList(locale, items, type, style),
      languageName: (tag) => languageName(locale, tag),
      compare: (a, b) => compareText(locale, a, b),
    }
    formatters.set(locale, made)
  }
  return made
}
