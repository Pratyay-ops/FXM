/**
 * Names the sync gives what it keeps in the library: the copies of the account's playlists and
 * of its liked songs, and the settings rows of its own state.
 *
 * A copy's ID is derived from what it copies (`local:playlist:spotify-<Spotify ID>`), so every
 * device, every backup and every account that has the playlist names that copy alike: a library
 * that came back from a backup, or from another device through library sync (stage 8.4), is
 * adopted by the next sync instead of copied a second time.
 *
 * @module
 */

import { type EntityId, formatId, parseId } from '@fxm/core'
import { isSpotifyId } from '@fxm/sources/spotify'

/** Where the sync keeps its state in the library's settings. Never `sync.`: it stays here. */
export const STATE_PREFIX = 'spotify-account.'

/** The settings row of the sync's own state. */
export const META_KEY = `${STATE_PREFIX}state`

/** The settings row of the personal home's copy. */
export const HOME_KEY = `${STATE_PREFIX}home`

/** The prefix of the settings rows of the copies, one per copied list. */
export const LIST_PREFIX = `${STATE_PREFIX}list.`

/** The key of liked songs among the copied lists. */
export const LIKED_LIST = 'liked'

/** The name of the copy of the account's liked songs. */
export const LIKED_NAME = 'Liked songs on Spotify'

/** The settings row of a copied list: liked songs, or a playlist by its Spotify ID. */
export function listKey(list: string): string {
  return `${LIST_PREFIX}${list}`
}

/** The account key's form: 22 URL-safe base64 characters. */
const ACCOUNT_KEY = /^[0-9A-Za-z_-]{22}$/u

/** Whether `value` is a Spotify base62 ID: 22 letters and digits, at most 128 bits. */
export function isSpotifyNativeId(value: unknown): value is string {
  return isSpotifyId(value)
}

/** Whether `value` is an account key ({@link accountKeyOf}). */
export function isAccountKey(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_KEY.test(value)
}

/**
 * The library ID of the copy of a Spotify playlist, by its base62 ID.
 *
 * @throws TypeError for anything but a base62 ID.
 */
export function playlistCopyId(spotifyId: string): EntityId<'playlist'> {
  if (!isSpotifyNativeId(spotifyId)) throw new TypeError('Not a Spotify playlist ID')
  return formatId('local', 'playlist', `spotify-${spotifyId}`)
}

/**
 * The library ID of the copy of an account's liked songs: one per account, by its key.
 *
 * @throws TypeError for anything but an account key.
 */
export function likedCopyId(account: string): EntityId<'playlist'> {
  if (!isAccountKey(account)) throw new TypeError('Not an account key')
  return formatId('local', 'playlist', `spotify-liked-${account}`)
}

/** Whether a library playlist is a copy the sync made (or would make): its ID says so. */
export function isSpotifyCopyId(id: string): boolean {
  const parts = parseId(id)
  return (
    parts !== null &&
    parts.source === 'local' &&
    parts.kind === 'playlist' &&
    parts.nativeId.startsWith('spotify-')
  )
}

/** The Spotify base62 ID in an FXM track ID (`spotify:track:<ID>`), or `undefined`. */
export function spotifyTrackIdOf(id: string): string | undefined {
  const parts = parseId(id)
  return parts?.source === 'spotify' && parts.kind === 'track' && isSpotifyNativeId(parts.nativeId)
    ? parts.nativeId
    : undefined
}

/** The FXM ID of a Spotify track, by its base62 ID. */
export function spotifyTrackId(nativeId: string): EntityId<'track'> {
  return formatId('spotify', 'track', nativeId)
}

/**
 * A key for a Spotify account, from its user name: the first 22 characters of the URL-safe
 * base64 SHA-256 of `spotify:` and the name. The sync tells accounts apart with it, without
 * keeping the user name itself in the library, its backups or a playlist ID.
 */
export async function accountKeyOf(username: string): Promise<string> {
  const bytes = new TextEncoder().encode(`spotify:${username}`)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').slice(0, 22)
}
