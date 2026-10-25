/**
 * Spotify IDs. FXM's canonical Spotify native ID is the 22-character base62 ID (see `ids.ts` in
 * `@fxm/core`); Spotify itself also writes IDs as URIs (`spotify:track:<id>`), as links
 * (`https://open.spotify.com/track/<id>`) and, on spclient, as 32-digit hexadecimal "gids".
 *
 * @module
 */

import { type EntityId, type EntityKind, formatId, parseId } from '@fxm/core'
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
export function base62ToHex(id: string): string {
  if (!isSpotifyId(id)) throw new RangeError('Not a Spotify ID: expected 22 base62 characters')
  return decodeBase62(id).toString(16).padStart(32, '0')
}

/**
 * The base62 Spotify ID of a 32-digit hexadecimal gid (either case), the inverse of
 * {@link base62ToHex}.
 *
 * @throws RangeError when `hex` is not 32 hexadecimal digits.
 */
export function hexToBase62(hex: string): string {
  const lower = typeof hex === 'string' ? hex.toLowerCase() : ''
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
const LINK =
  /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?([a-z]+)\/([^/?#\s]+)/iu

/**
 * Splits a Spotify URI such as `spotify:track:70LcF31zb1H0PyJoS1Sx1r` into its type and ID.
 * Catalog types (`track`, `album`, `artist`, `playlist`, `episode`, `show`) must carry a valid
 * base62 ID. Returns `null`, and never throws, for anything else.
 */
export function parseSpotifyUri(uri: unknown): SpotifyRef | null {
  if (typeof uri !== 'string') return null
  const match = URI.exec(uri.trim())
  if (!match) return null
  const [, type = '', id = ''] = match
  return CATALOG_TYPES.has(type) && !isSpotifyId(id) ? null : { type, id }
}

const CATALOG_TYPES = new Set(['track', 'album', 'artist', 'playlist', 'episode', 'show'])

/**
 * Reads a Spotify URI or an open.spotify.com link, as a user pastes it, e.g.
 * `https://open.spotify.com/intl-de/track/70LcF31zb1H0PyJoS1Sx1r?si=…`. Returns `null`, and
 * never throws, when it is neither.
 */
export function parseSpotifyLink(text: unknown): SpotifyRef | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.startsWith('spotify:')) return parseSpotifyUri(trimmed)
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
 * `spotify:track:<id>` as an `EntityId<'track'>`. `undefined` when the URI is malformed or of
 * another kind.
 */
export function entityIdFromUri<K extends EntityKind>(
  kind: K,
  uri: unknown,
): EntityId<K> | undefined {
  const ref = parseSpotifyUri(uri)
  return ref && ref.type === kind && isSpotifyId(ref.id)
    ? formatId('spotify', kind, ref.id)
    : undefined
}

/**
 * The base62 Spotify ID inside an FXM ID of the given kind.
 *
 * @throws SpotifyError `Unsupported` (`foreign-id`) when the ID is not a Spotify ID of that kind,
 * and `NotFound` (`not-found`) when its native ID is not a valid base62 Spotify ID.
 */
export function spotifyIdOf<K extends EntityKind>(id: EntityId<K>, kind: K): string {
  const parts = parseId(id as unknown)
  if (parts === null || parts.kind !== kind || parts.source !== 'spotify') {
    throw new SpotifyError('Unsupported', 'foreign-id', `Not a Spotify ${kind} ID: ${String(id)}`)
  }
  if (!isSpotifyId(parts.nativeId)) {
    throw new SpotifyError('NotFound', 'not-found', `Malformed Spotify ${kind} ID: ${String(id)}`)
  }
  return parts.nativeId
}
