/**
 * Stable identifiers for local copies of one YouTube Music account's library.
 *
 * Account identifiers are hashed before they appear in library settings or playlist IDs. The
 * raw Google/YouTube account identifier is used only in memory during one sync.
 *
 * @module
 */

import { formatId } from '@fxm/core'

/** Library setting rows stay local to this device; never use the `sync.` prefix. */
export const STATE_PREFIX = 'youtube-music-account.'
export const LIKED_LIST = 'liked'
export const SONGS_LIST = 'songs'

/** A stable, non-reversible key for an account/channel identifier. */
export async function accountKeyOf(accountId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`youtube-music:${accountId}`)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join('')
}

/** The one settings row of this account's sync state. */
export function stateKey(accountKey: string): string {
  return `${STATE_PREFIX}${accountKey}`
}

/** The local playlist that copies YouTube Music Liked Songs for this account. */
export function likedCopyId(accountKey: string) {
  return formatId('local', 'playlist', `youtube-music-${accountKey}-liked`)
}

/** The local playlist that copies YouTube Music's Songs filter for this account. */
export function songsCopyId(accountKey: string) {
  return formatId('local', 'playlist', `youtube-music-${accountKey}-songs`)
}

/** The local playlist for one remote YouTube Music playlist. */
export async function playlistCopyId(accountKey: string, playlistId: string) {
  const nativeId = await accountKeyOf(`${accountKey}:playlist:${playlistId}`)
  return formatId('local', 'playlist', `youtube-music-${accountKey}-playlist-${nativeId}`)
}
