/**
 * IDs of local tracks, albums and artists, and the hash they are made from.
 *
 * A local track's native ID is a hash of the file's place: the root folder's name and the
 * path inside it (`Music/Artist/Album/01 Song.flac`). So it is the same on every rescan, after
 * removing and adding the folder again, and in another browser that reads the same folder,
 * which keeps likes and playlists pointing at the file. A rescan that finds a file moved keeps
 * its old ID (see `scanner.ts`). Albums and artists get IDs from their normalized names, so the
 * tracks of one album group together whatever folder they are in.
 *
 * The hash is 64-bit FNV-1a over UTF-8: public domain, synchronous (it works in insecure
 * contexts, where `crypto.subtle` is missing) and fast enough for tens of thousands of paths.
 * It is not a security measure: nothing here needs one.
 *
 * @module
 */

import { type EntityId, formatId, normalizeText } from '@fxm/core'

const encoder = new TextEncoder()

/**
 * 64-bit FNV-1a of `bytes`, as 16 hex digits. The state is kept as four 16-bit limbs, so plain
 * numbers do the 64-bit multiplication by the FNV prime (2^40 + 0x1b3) exactly, without BigInt.
 */
export function fnv1a64(bytes: Uint8Array): string {
  // The offset basis 0xcbf29ce484222325, lowest limb first.
  let h0 = 0x2325
  let h1 = 0x8422
  let h2 = 0x9ce4
  let h3 = 0xcbf2
  for (const byte of bytes) {
    h0 ^= byte
    // h × 0x1b3, plus h × 2^40, which adds h0 << 8 to limb 2 and h1 << 8 to limb 3 (the rest
    // overflows 64 bits). No intermediate value reaches 2^32, so >>> 16 carries exactly.
    let carry = h0 * 0x1b3
    const n0 = carry & 0xffff
    carry = h1 * 0x1b3 + (carry >>> 16)
    const n1 = carry & 0xffff
    carry = h2 * 0x1b3 + (h0 << 8) + (carry >>> 16)
    const n2 = carry & 0xffff
    carry = h3 * 0x1b3 + (h1 << 8) + (carry >>> 16)
    h3 = carry & 0xffff
    h2 = n2
    h1 = n1
    h0 = n0
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, '0')).join('')
}

/** {@link fnv1a64} of a string, in Unicode NFC (macOS file systems may hand out NFD names). */
export function stableHash(text: string): string {
  return fnv1a64(encoder.encode(text.normalize('NFC')))
}

/**
 * The native ID a file at `path` inside the root `rootName` gets when it is first seen. When
 * `taken` already holds it (another file kept that ID after moving), a counter is mixed in until
 * the ID is free, so no two files share one.
 */
export function newTrackNativeId(
  rootName: string,
  path: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const place = `${rootName}/${path}`
  let id = stableHash(place)
  for (let attempt = 1; taken.has(id); attempt++) id = stableHash(`${place}#${attempt}`)
  return id
}

/** The track ID of a local file. */
export function localTrackId(nativeId: string): EntityId<'track'> {
  return formatId('local', 'track', nativeId)
}

/** The name as IDs and grouping compare it: case, accents and spacing don't matter. */
function nameKey(name: string): string {
  return normalizeText(name)
}

/** The ID of a local album: by its album artist and name. */
export function localAlbumId(albumArtist: string, album: string): EntityId<'album'> {
  return formatId('local', 'album', stableHash(`${nameKey(albumArtist)}\u0000${nameKey(album)}`))
}

/** The ID of a local artist: by name. */
export function localArtistId(name: string): EntityId<'artist'> {
  return formatId('local', 'artist', stableHash(nameKey(name)))
}
