/**
 * The connected account's personal home, as the sync keeps it in the library for Home's Spotify
 * sections (stage 3.3): read back here, and checked field by field, since it also comes back
 * from backups.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type ArtistRef,
  type Artwork,
  cleanTrack,
  type EntityId,
  isEntityId,
  type Playlist,
  parseId,
  type Shelf,
  type ShelfItem,
} from '@fxm/core'
import { HOME_KEY, isAccountKey } from './ids'
import type { StateStore } from './state'
import type { HomeCopy } from './sync'

/** How long the kept home counts as fresh: Spotify's own home changes about that often. */
export const HOME_FRESH_MS = 30 * 60_000

/** How old a kept home may be and still show, when a fresh one can't be read. */
export const HOME_KEEP_MS = 7 * 24 * 60 * 60_000

const MAX_SHELVES = 40
const MAX_ITEMS = 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined
}

function artworkOf(value: unknown): Artwork[] {
  if (!Array.isArray(value)) return []
  const artwork: Artwork[] = []
  for (const item of value.slice(0, 8)) {
    const url = isRecord(item) ? text(item.url, 2048) : undefined
    if (url === undefined || !url.startsWith('https://')) continue
    const size = (n: unknown) =>
      typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 100_000 ? n : undefined
    const width = size((item as Record<string, unknown>).width)
    const height = size((item as Record<string, unknown>).height)
    artwork.push({
      url,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
  }
  return artwork
}

function artistsOf(value: unknown): ArtistRef[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).flatMap((item): ArtistRef[] => {
    const name = isRecord(item) ? text(item.name) : undefined
    if (name === undefined) return []
    return [isEntityId(item?.id, 'artist') ? { id: item.id, name } : { name }]
  })
}

/** A Spotify entity's ID of `kind`, or `undefined`. */
function spotifyId<K extends 'album' | 'artist' | 'playlist'>(
  value: unknown,
  kind: K,
): EntityId<K> | undefined {
  return isEntityId(value, kind) && parseId(value).source === 'spotify' ? value : undefined
}

function itemOf(value: unknown): ShelfItem | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'track': {
      const track = cleanTrack(value.track)
      return track && track.source === 'spotify' ? { type: 'track', track } : undefined
    }
    case 'album': {
      const album = isRecord(value.album) ? value.album : {}
      const id = spotifyId(album.id, 'album')
      const name = text(album.name)
      if (id === undefined || name === undefined) return undefined
      const entity: Album = {
        id,
        source: 'spotify',
        name,
        artists: artistsOf(album.artists),
        artwork: artworkOf(album.artwork),
      }
      return { type: 'album', album: entity }
    }
    case 'artist': {
      const artist = isRecord(value.artist) ? value.artist : {}
      const id = spotifyId(artist.id, 'artist')
      const name = text(artist.name)
      if (id === undefined || name === undefined) return undefined
      const entity: Artist = { id, source: 'spotify', name, artwork: artworkOf(artist.artwork) }
      return { type: 'artist', artist: entity }
    }
    case 'playlist': {
      const playlist = isRecord(value.playlist) ? value.playlist : {}
      const id = spotifyId(playlist.id, 'playlist')
      const name = text(playlist.name)
      if (id === undefined || name === undefined) return undefined
      const owner = isRecord(playlist.owner) ? text(playlist.owner.name) : undefined
      const description = text(playlist.description, 2000)
      const entity: Playlist = {
        id,
        source: 'spotify',
        name,
        artwork: artworkOf(playlist.artwork),
        ...(owner === undefined ? {} : { owner: { name: owner } }),
        ...(description === undefined ? {} : { description }),
      }
      return { type: 'playlist', playlist: entity }
    }
    default:
      return undefined
  }
}

function shelfOf(value: unknown): Shelf | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 300)
  const title = text(value.title, 300)
  if (id === undefined || title === undefined || !Array.isArray(value.items)) return undefined
  const items = value.items
    .slice(0, MAX_ITEMS)
    .map(itemOf)
    .filter((item) => item !== undefined)
  if (items.length === 0) return undefined
  const subtitle = text(value.subtitle, 300)
  return { id, title, items, ...(subtitle === undefined ? {} : { subtitle }) }
}

/** The kept home read back, or `undefined` when it can't be read. */
export function sanitizeHomeCopy(value: unknown): HomeCopy | undefined {
  if (!isRecord(value) || !isAccountKey(value.account) || !Array.isArray(value.shelves)) {
    return undefined
  }
  const { at } = value
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined
  const shelves = value.shelves
    .slice(0, MAX_SHELVES)
    .map(shelfOf)
    .filter((shelf) => shelf !== undefined)
  return { account: value.account, at, shelves }
}

/** The kept home, or `undefined`. */
export async function readHome(
  store: Pick<StateStore, 'getSetting'>,
): Promise<HomeCopy | undefined> {
  return sanitizeHomeCopy(await store.getSetting(HOME_KEY))
}
