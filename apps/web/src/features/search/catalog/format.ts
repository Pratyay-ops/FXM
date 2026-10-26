import type { AlbumType, ArtistRef, EntityId, Track, TrackKind } from '@fxm/core'
import { entityKey } from '@fxm/core'
import { formatTime } from '@fxm/player'

/** A duration in milliseconds as `m:ss` (`h:mm:ss` from one hour), or `undefined` if unknown. */
export function formatDuration(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) || ms < 0 ? undefined : formatTime(ms / 1000)
}

/** A total running time for people: `1 hr 5 min`, `48 min`, or `40 sec` under a minute. */
export function formatTotalDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} sec`
  const totalMinutes = Math.round(totalSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`
}

/** The sum of the known durations, or `undefined` when none is known. */
export function totalDuration(tracks: readonly Track[]): number | undefined {
  let total = 0
  let known = false
  for (const track of tracks) {
    if (track.durationMs === undefined) continue
    total += track.durationMs
    known = true
  }
  return known ? total : undefined
}

/** The year of an ISO 8601 date such as `2013-05-17`, or `undefined`. */
export function releaseYear(date: string | undefined): string | undefined {
  return date?.match(/^\d{4}/u)?.[0]
}

/** `1 song`, `12 songs`. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? singular : plural}`
}

/** Artist names joined for reading: `Nova Lane, Mira Sol`. */
export function artistNames(artists: readonly ArtistRef[]): string {
  return artists.map((artist) => artist.name).join(', ')
}

const TRACK_KIND_LABELS: Readonly<Record<TrackKind, string>> = {
  song: 'Song',
  'music-video': 'Official video',
  video: 'Video',
  episode: 'Episode',
}

/** What a track is, for its kind badge: `Song`, `Official video`, `Video` or `Episode`. */
export function trackKindLabel(kind: TrackKind): string {
  return Object.hasOwn(TRACK_KIND_LABELS, kind) ? TRACK_KIND_LABELS[kind] : 'Track'
}

const ALBUM_TYPE_LABELS: Readonly<Record<AlbumType, string>> = {
  album: 'Album',
  single: 'Single',
  ep: 'EP',
  compilation: 'Compilation',
}

/** What an album is, for its kind badge: `Album`, `Single`, `EP` or `Compilation`. */
export function albumTypeLabel(type: AlbumType | undefined): string {
  return type !== undefined && Object.hasOwn(ALBUM_TYPE_LABELS, type)
    ? ALBUM_TYPE_LABELS[type]
    : 'Album'
}

/**
 * Keeps the first of each entity (`ytm` and `yt` IDs of one video count as one), so that a page
 * that repeats an item from the page before it does not repeat a row.
 */
export function uniqueById<T extends { readonly id: EntityId }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = entityKey(item.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * React keys for a list that may hold the same item more than once (a playlist can repeat a
 * song): the ID, plus `#2`, `#3` … for repeats.
 */
export function listKeys(items: readonly { readonly id: string }[]): string[] {
  const counts = new Map<string, number>()
  return items.map((item) => {
    const count = (counts.get(item.id) ?? 0) + 1
    counts.set(item.id, count)
    return count === 1 ? item.id : `${item.id}#${count}`
  })
}
