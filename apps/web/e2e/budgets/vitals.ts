// Largest Contentful Paint, Cumulative Layout Shift and Interaction to Next Paint, measured in
// the page with the browser's own performance entries, the way web-vitals computes them:
// `observeVitals` records the entries from the first moment of the page, and the functions below
// turn them into the three numbers.

/** A `largest-contentful-paint` entry: when the largest element so far painted. */
export interface PaintEntry {
  /** Milliseconds since the navigation started. */
  readonly startTime: number
  readonly size: number
  /** The element, as `tag#id.class "its text…"`, to say what the largest paint was. */
  readonly element: string
}

/** A `layout-shift` entry. */
export interface ShiftEntry {
  readonly startTime: number
  readonly value: number
  readonly hadRecentInput: boolean
}

/** An `event` or `first-input` entry of an interaction (Event Timing). */
export interface InteractionEntry {
  readonly interactionId: number
  readonly name: string
  readonly startTime: number
  /** From the input to the next paint after its handlers ran, in 8 ms steps. */
  readonly duration: number
}

/** What {@link observeVitals} keeps on the page. */
export interface VitalsRecord {
  readonly paints: PaintEntry[]
  readonly shifts: ShiftEntry[]
  readonly interactions: InteractionEntry[]
}

/** The window property {@link observeVitals} keeps its record in. */
export const VITALS_KEY = 'fxmVitals'

/**
 * An init script (`page.addInitScript(observeVitals)`) that records the page's paints, layout
 * shifts and interactions from its first moment in `window.fxmVitals`. Interactions shorter than
 * 16 ms, the least Event Timing reports, aren't recorded.
 */
export function observeVitals(): void {
  const record: VitalsRecord = { paints: [], shifts: [], interactions: [] }
  Object.assign(window, { fxmVitals: record })
  const describe = (element: Element | null | undefined) => {
    if (element === null || element === undefined) return '(removed)'
    const id = element.id === '' ? '' : `#${element.id}`
    const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`)
    const text = (element.textContent ?? '').trim().replace(/\s+/gu, ' ')
    const words = text.length > 40 ? `${text.slice(0, 40)}…` : text
    const quoted = words === '' ? '' : ` "${words}"`
    return `${element.tagName.toLowerCase()}${id}${classes.join('')}${quoted}`
  }
  const observe = (type: string, options: object, take: (entry: PerformanceEntry) => void) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) take(entry)
      }).observe({ type, buffered: true, ...options })
    } catch {
      // An entry type this browser doesn't know: its number stays empty.
    }
  }
  observe('largest-contentful-paint', {}, (entry) => {
    const paint = entry as PerformanceEntry & { size: number; element?: Element | null }
    record.paints.push({
      startTime: paint.startTime,
      size: paint.size,
      element: describe(paint.element),
    })
  })
  observe('layout-shift', {}, (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
    record.shifts.push({
      startTime: shift.startTime,
      value: shift.value,
      hadRecentInput: shift.hadRecentInput,
    })
  })
  const interaction = (entry: PerformanceEntry) => {
    const event = entry as PerformanceEntry & { interactionId?: number }
    if (!event.interactionId) return
    record.interactions.push({
      interactionId: event.interactionId,
      name: event.name,
      startTime: event.startTime,
      duration: event.duration,
    })
  }
  observe('event', { durationThreshold: 16 }, interaction)
  observe('first-input', {}, interaction)
}

/** Largest Contentful Paint: the last largest paint, in milliseconds, or `undefined` if none. */
export function largestContentfulPaint(paints: readonly PaintEntry[]): PaintEntry | undefined {
  return paints.reduce<PaintEntry | undefined>(
    (latest, paint) =>
      latest === undefined || paint.startTime >= latest.startTime ? paint : latest,
    undefined,
  )
}

/**
 * Cumulative Layout Shift: the largest sum of the shifts in a session window, a burst of shifts
 * less than 1 s apart and within 5 s, leaving out shifts right after an input.
 */
export function cumulativeLayoutShift(shifts: readonly ShiftEntry[]): number {
  let largest = 0
  let window = 0
  let first = Number.NEGATIVE_INFINITY
  let previous = Number.NEGATIVE_INFINITY
  for (const shift of [...shifts].sort((a, b) => a.startTime - b.startTime)) {
    if (shift.hadRecentInput) continue
    if (shift.startTime - previous < 1000 && shift.startTime - first < 5000) {
      window += shift.value
    } else {
      window = shift.value
      first = shift.startTime
    }
    previous = shift.startTime
    largest = Math.max(largest, window)
  }
  return largest
}

/**
 * Interaction to Next Paint: the longest interaction (the longest of its events), or, with 50
 * or more, the longest but one per 50, so one outlier in a long session doesn't count. 0 when
 * no interaction took 16 ms or more.
 */
export function interactionToNextPaint(entries: readonly InteractionEntry[]): number {
  const longest = new Map<number, number>()
  for (const entry of entries) {
    longest.set(
      entry.interactionId,
      Math.max(longest.get(entry.interactionId) ?? 0, entry.duration),
    )
  }
  const durations = [...longest.values()].sort((a, b) => b - a)
  if (durations.length === 0) return 0
  return durations[Math.min(Math.floor(durations.length / 50), durations.length - 1)] ?? 0
}

/** The median of some numbers (the mean of the middle two for an even count). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('No values to take the median of')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
