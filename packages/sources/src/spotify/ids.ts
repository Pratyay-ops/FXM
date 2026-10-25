/**
 * Spotify IDs. FXM's canonical Spotify native ID is the 22-character base62 ID (see `ids.ts` in
 * `@fxm/core`); Spotify itself also writes IDs as URIs (`spotify:track:<id>`), as links
 * (`https://open.spotify.com/track/<id>`) and, on spclient, as 32-digit hexadecimal "gids".
 *
 * Every function that reads a value it was handed returns `null`, and never throws, when the
 * value is not a Spotify reference of the kind asked for.
 *
 * @module
 */

import { type EntityId, type EntityKind, formatId, isEntityKind, parseId } from '@fxm/core'
import { SpotifyError } from './errors'

/** Spotify's base62 alphabet: digits, then lower case, then upper case. */
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/u
const GID = /^[0-9a-f]{32}$/u
const MAX_GID = (1n << 128n) - 1n

/** Whether `value` is a 22-character base62 Spotify ID (any 128-bit value). */
export function isSpotifyId(value: unknown): value is string {
  if (typeof value !== 'string' || !SPOTIFY_ID.test(value)) return false
  return decodeBase62(value) <= MAX_GID
}

function decodeBase62(id: string): bigint {
  let value = 0n
  for (const char of id) value = value * 62n + BigInt(BASE62.indexOf(char))
  return value
}

/**
 * The 32-digit lower-case hexadecimal "gid" of a base62 Spotify ID, as spclient's `metadata/4`
 * endpoints take it: `70LcF31zb1H0PyJoS1Sx1r` → `e666c6ccc4c7437f83552aa9bf4f2cfd`.
 *
 * @throws RangeError when `id` is not a 22-character base62 ID of at most 128 bits.
 */
export function spotifyIdToGid(id: string): string {
  if (!isSpotifyId(id)) throw new RangeError('Not a Spotify ID: expected 22 base62 characters')
  return decodeBase62(id).toString(16).padStart(32, '0')
}

/**
 * The base62 Spotify ID of a 32-digit hexadecimal gid (either case), the inverse of
 * {@link spotifyIdToGid}.
 *
 * @throws RangeError when `gid` is not 32 hexadecimal digits.
 */
export function gidToSpotifyId(gid: string): string {
  const lower = typeof gid === 'string' ? gid.toLowerCase() : ''
  if (!GID.test(lower)) throw new RangeError('Not a Spotify gid: expected 32 hexadecimal digits')
  let value = BigInt(`0x${lower}`)
  let id = ''
  while (value > 0n) {
    id = BASE62.charAt(Number(value % 62n)) + id
    value /= 62n
  }
  return id.padStart(22, '0')
}

/** A Spotify entity named by a URI or link. */
export interface SpotifyRef {
  /** The entity type as Spotify spells it, e.g. `track`, `album`, `artist`, `playlist`. */
  type: string
  /** The entity's ID: base62 for catalog entities, free text for users. */
  id: string
}

const URI = /^spotify:([a-z]+):([^:\s]+)$/u
/** The playlist URIs of Spotify's older clients: `spotify:user:<user>:playlist:<id>`. */
const LEGACY_PLAYLIST_URI = /^spotify:user:[^:\s]+:playlist:([^:\s]+)$/u
const LINK_ORIGIN = String.raw`^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?`
const LINK = new RegExp(`${LINK_ORIGIN}([a-z]+)\\/([^/?#\\s]+)`, 'iu')
/** The playlist links of Spotify's older clients: `open.spotify.com/user/<user>/playlist/<id>`. */
const LEGACY_PLAYLIST_LINK = new RegExp(
  `${LINK_ORIGIN}user\\/[^/?#\\s]+\\/playlist\\/([^/?#\\s]+)`,
  'iu',
)

const CATALOG_TYPES = new Set(['track', 'album', 'artist', 'playlist', 'episode', 'show'])

/**
 * Splits a Spotify URI such as `spotify:track:70LcF31zb1H0PyJoS1Sx1r` into its type and ID. The
 * older `spotify:user:<user>:playlist:<id>` names the playlist. Catalog types (`track`, `album`,
 * `artist`, `playlist`, `episode`, `show`) must carry a valid base62 ID. Returns `null`, and
 * never throws, for anything else.
 */
export function parseSpotifyUri(uri: unknown): SpotifyRef | null {
  if (typeof uri !== 'string') return null
  const trimmed = uri.trim()
  const legacy = LEGACY_PLAYLIST_URI.exec(trimmed)
  if (legacy) return isSpotifyId(legacy[1]) ? { type: 'playlist', id: legacy[1] } : null
  const match = URI.exec(trimmed)
  if (!match) return null
  const [, type = '', id = ''] = match
  return CATALOG_TYPES.has(type) && !isSpotifyId(id) ? null : { type, id }
}

/**
 * Reads a Spotify URI or an open.spotify.com link, as a user pastes it or an export lists it,
 * e.g. `https://open.spotify.com/intl-de/track/70LcF31zb1H0PyJoS1Sx1r?si=…`. The older playlist
 * forms `open.spotify.com/user/<user>/playlist/<id>` and `spotify:user:<user>:playlist:<id>`
 * name the playlist. Returns `null`, and never throws, when it is neither.
 */
export function parseSpotifyLink(text: unknown): SpotifyRef | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.startsWith('spotify:')) return parseSpotifyUri(trimmed)
  const legacy = LEGACY_PLAYLIST_LINK.exec(trimmed)
  if (legacy) return parseSpotifyUri(`spotify:playlist:${legacy[1] ?? ''}`)
  const match = LINK.exec(trimmed)
  if (!match) return null
  const [, type = '', id = ''] = match
  return parseSpotifyUri(`spotify:${type.toLowerCase()}:${id}`)
}

/** The Spotify URI of an entity, e.g. `spotify:track:70LcF31zb1H0PyJoS1Sx1r`. */
export function spotifyUri(kind: EntityKind, id: string): string {
  return `spotify:${kind}:${id}`
}

/**
 * The FXM ID of a Spotify URI of the given kind, e.g. `spotify:track:<id>` →
 * `spotify:track:<id>` as an `EntityId<'track'>`. `null` when the URI is malformed or of another
 * kind.
 */
export function spotifyEntityIdFromUri<K extends EntityKind>(
  kind: K,
  uri: unknown,
): EntityId<K> | null {
  const ref = parseSpotifyUri(uri)
  return ref && ref.type === kind && isSpotifyId(ref.id) ? formatId('spotify', kind, ref.id) : null
}

/**
 * The FXM ID of a pasted Spotify link or URI (see {@link parseSpotifyLink}), e.g. for an import
 * or the search box: `https://open.spotify.com/album/<id>?si=…` → `spotify:album:<id>`. With
 * `kind`, only a link of that kind counts. `null` for anything that is not a link to a Spotify
 * track, album, artist or playlist.
 */
export function spotifyEntityIdFromLink(text: unknown): EntityId | null
export function spotifyEntityIdFromLink<K extends EntityKind>(
  text: unknown,
  kind: K,
): EntityId<K> | null
export function spotifyEntityIdFromLink(text: unknown, kind?: EntityKind): EntityId | null {
  const ref = parseSpotifyLink(text)
  if (!ref || !isEntityKind(ref.type) || (kind !== undefined && ref.type !== kind)) return null
  return isSpotifyId(ref.id) ? formatId('spotify', ref.type, ref.id) : null
}

/**
 * The base62 Spotify ID inside an FXM ID of the given kind.
 *
 * @throws SpotifyError `foreign-id` when the ID is not a Spotify ID of that kind, and
 * `not-found` when its native ID is not a valid base62 Spotify ID.
 */
export function spotifyIdOf<K extends EntityKind>(id: EntityId<K>, kind: K): string {
  const parts = parseId(id as unknown)
  if (parts === null || parts.kind !== kind || parts.source !== 'spotify') {
    throw new SpotifyError('foreign-id', `Not a Spotify ${kind} ID: ${String(id)}`)
  }
  if (!isSpotifyId(parts.nativeId)) {
    throw new SpotifyError('not-found', `Malformed Spotify ${kind} ID: ${String(id)}`)
  }
  return parts.nativeId
}
