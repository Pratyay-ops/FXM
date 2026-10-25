import type { Artwork, Track } from '@fxm/core'
import { formatTime } from '@fxm/player'

/** "1 song", "12 songs", "1,204 songs". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? singular : plural}`
}

/** The credited artists, main artist first: "Daft Punk, Pharrell Williams". */
export function artistNames(track: Track | undefined): string {
  return track?.artists.map((artist) => artist.name).join(', ') ?? ''
}

/** A track's length as `m:ss`, or an empty string when unknown. */
export function trackDuration(track: Track | undefined): string {
  return track?.durationMs === undefined ? '' : formatTime(track.durationMs / 1000)
}

/** The total length of a list: "1 hr 5 min", "45 min", "under a minute". */
export function totalDuration(durationsMs: readonly (number | undefined)[]): string {
  const total = durationsMs.reduce<number>((sum, ms) => sum + (ms ?? 0), 0)
  const minutes = Math.round(total / 60_000)
  if (total === 0) return ''
  if (minutes < 1) return 'under a minute'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours} hr ${rest} min` : `${rest} min`
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })

/** When something joined a list: "today", "yesterday", "3 days ago", then a date. */
export function addedLabel(at: number | undefined, now = Date.now()): string {
  if (at === undefined || at <= 0) return ''
  const day = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const days = Math.ceil((startOfToday - at) / day)
  if (days <= 0) return 'today'
  if (days < 7) return relative.format(-days, 'day')
  return dateFormat.format(at)
}

/** When something played: "just now", "5 minutes ago", "2 hours ago", then like {@link addedLabel}. */
export function playedLabel(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return relative.format(-hours, 'hour')
  return addedLabel(at, now)
}

/**
 * The URL of the smallest artwork at least `size` pixels wide, else the largest there is.
 * Undefined when there is no artwork.
 */
export function artworkUrl(
  artwork: readonly Artwork[] | undefined,
  size: number,
): string | undefined {
  if (artwork === undefined || artwork.length === 0) return undefined
  const sized = [...artwork].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return (sized.find((item) => (item.width ?? 0) >= size) ?? sized[sized.length - 1])?.url
}
