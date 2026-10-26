/**
 * MusicBrainz IDs (MBIDs), which MusicBrainz, ListenBrainz, the Cover Art Archive and Last.fm all
 * use: UUIDs, written in lower case.
 *
 * @module
 */

/** A MusicBrainz ID in its canonical form: a lower-case UUID. */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Whether `value` is a MusicBrainz ID in its canonical, lower-case form. */
export function isMbid(value: unknown): value is string {
  return typeof value === 'string' && MBID.test(value)
}

/**
 * `value` as a canonical MusicBrainz ID, trimmed and in lower case, or `undefined` when it is
 * not one.
 */
export function normalizeMbid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const mbid = value.trim().toLowerCase()
  return MBID.test(mbid) ? mbid : undefined
}

/**
 * `value` as a canonical MusicBrainz ID, for a client that takes one. Throws a `RangeError`, as
 * MusicBrainz's own client does, when it is not one: a caller passing anything else has a bug,
 * which an empty answer would hide.
 */
export function requireMbid(value: string): string {
  const mbid = normalizeMbid(value)
  if (mbid === undefined) {
    throw new RangeError(`Not a MusicBrainz ID: ${String(value).slice(0, 64)}`)
  }
  return mbid
}
