/**
 * Local files as a `MetadataProvider` (source `local`, "This device"), so search and the album
 * and artist pages treat them like any other catalog: stage 2.4's sources registry registers it
 * with `sources.register(createLocalMetadataProvider())`.
 *
 * It searches the songs, albums and artists of the listed files and loads local albums and
 * artists by the IDs `ids.ts` gives them. Local playlists belong to the library, so
 * `getPlaylist` finds none. Everything is on the device: the context's `fetch` goes unused, and
 * every local track is a song, so both catalog modes show them all.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type EntityId,
  FxmError,
  type MetadataProvider,
  type Page,
  type PageOptions,
  type SearchResults,
  type Track,
} from '@fxm/core'
import { localArtistId } from './ids'
import { getLocalFiles, type LocalFiles } from './local-files'
import {
  albumArtistOf,
  type LocalTrack,
  searchLocalTracks,
  sortLocalTracks,
  toLocalTracks,
} from './tracks'

/** Results per page when the caller sets no limit. */
const DEFAULT_LIMIT = 20

/** One page of `items` from an offset cursor. */
export function pageOf<T>(items: readonly T[], { limit, cursor }: PageOptions = {}): Page<T> {
  const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const size = Math.max(1, limit ?? DEFAULT_LIMIT)
  const page: Page<T> = { items: items.slice(start, start + size), total: items.length }
  if (start + size < items.length) page.nextCursor = String(start + size)
  return page
}

/** The albums of `tracks`, in the order their first track comes. */
export function albumsOf(tracks: readonly LocalTrack[]): Album[] {
  const albums = new Map<string, { album: Album; tracks: Track[] }>()
  for (const { track, file } of tracks) {
    if (track.album?.id === undefined) continue
    let entry = albums.get(track.album.id)
    if (entry === undefined) {
      const artist = albumArtistOf(file.tags)
      const album: Album = {
        id: track.album.id,
        source: 'local',
        name: track.album.name,
        artists: artist === '' ? [] : [{ id: localArtistId(artist), name: artist }],
        artwork: track.artwork,
      }
      entry = { album, tracks: [] }
      albums.set(track.album.id, entry)
    }
    if (entry.album.artwork.length === 0) entry.album.artwork = track.artwork
    const date = track.releaseDate
    if (
      date !== undefined &&
      (entry.album.releaseDate === undefined || date < entry.album.releaseDate)
    ) {
      entry.album.releaseDate = date
    }
    entry.tracks.push(track)
  }
  return [...albums.values()].map(({ album, tracks: albumTracks }) => ({
    ...album,
    trackCount: albumTracks.length,
  }))
}

/** The artists of `tracks` (credited and album artists), in the order they first come. */
export function artistsOf(tracks: readonly LocalTrack[]): Artist[] {
  const artists = new Map<string, Artist>()
  for (const { track, file } of tracks) {
    const names = [...track.artists.map((artist) => artist.name), albumArtistOf(file.tags)]
    for (const name of names) {
      if (name === '') continue
      const id = localArtistId(name)
      if (!artists.has(id)) artists.set(id, { id, source: 'local', name, artwork: [] })
    }
  }
  return [...artists.values()]
}

/** The local-files metadata provider; `files` defaults to the app's. */
export function createLocalMetadataProvider(
  files: () => LocalFiles = getLocalFiles,
): MetadataProvider {
  const allTracks = async (): Promise<LocalTrack[]> => {
    const { repo } = files()
    const records = await repo.listFiles()
    const keys = [...new Set(records.flatMap((file) => file.pictureKey ?? []))]
    return toLocalTracks(records, await repo.getPictures(keys))
  }

  const notFound = (id: string) =>
    new FxmError('NotFound', `Nothing in your local files has ID ${id}`)

  return {
    id: 'local',

    async search(query, options) {
      const matches = searchLocalTracks(await allTracks(), query)
      const results: SearchResults = {}
      for (const type of options.types) {
        if (type === 'track') {
          results.tracks = pageOf(
            matches.map(({ track }) => track),
            options,
          )
        } else if (type === 'album') {
          results.albums = pageOf(albumsOf(matches), options)
        } else if (type === 'artist') {
          results.artists = pageOf(artistsOf(matches), options)
        } else if (type === 'playlist') {
          results.playlists = { items: [] }
        } else {
          results.videos = { items: [] }
        }
      }
      return results
    },

    async getTrack(id) {
      const found = (await allTracks()).find(({ track }) => track.id === id)
      if (found === undefined) throw notFound(id)
      return found.track
    },

    async getAlbum(id: EntityId<'album'>) {
      const tracks = sortLocalTracks(
        (await allTracks()).filter(({ track }) => track.album?.id === id),
        'album',
      )
      const album = albumsOf(tracks)[0]
      if (album === undefined) throw notFound(id)
      return { ...album, tracks: tracks.map(({ track }) => track) }
    },

    async getArtist(id: EntityId<'artist'>) {
      const tracks = (await allTracks()).filter(
        ({ track, file }) =>
          track.artists.some((artist) => artist.id === id) ||
          localArtistId(albumArtistOf(file.tags)) === id,
      )
      const artist = artistsOf(tracks).find((candidate) => candidate.id === id)
      if (artist === undefined) throw notFound(id)
      const sorted = sortLocalTracks(tracks, 'artist')
      return {
        ...artist,
        topTracks: sorted.map(({ track }) => track),
        albums: albumsOf(sorted).filter((album) =>
          album.artists.some((albumArtist) => albumArtist.id === id),
        ),
      }
    },

    async getPlaylist(id) {
      throw notFound(id)
    },
  }
}
