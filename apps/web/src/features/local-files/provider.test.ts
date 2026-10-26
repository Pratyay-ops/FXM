import { isFxmError, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { localAlbumId, localArtistId, localTrackId } from './ids'
import { createLocalMetadataProvider, pageOf } from './provider'
import { asHandle, audioFile, fakeFolder, flacFile, type TestTags, testLocalFiles } from './testing'

const CONTEXT = { mode: 'music' } as ProviderContext

function song(tags: TestTags) {
  return audioFile(flacFile({ tags }), `${tags.title}.flac`)
}

async function provider() {
  const folder = fakeFolder('Music', {
    'Aria/Neon/1.flac': song({
      title: 'Night Drive',
      artists: ['Aria Vale'],
      album: 'Neon Rivers',
      track: 1,
      date: '2021',
    }),
    'Aria/Neon/2.flac': song({
      title: 'Slow Tide',
      artists: ['Aria Vale', 'Theo Marsh'],
      album: 'Neon Rivers',
      track: 2,
    }),
    'Aria/Older/1.flac': song({
      title: 'First Light',
      artists: ['Aria Vale'],
      album: 'Older Songs',
      track: 1,
      date: '2015',
    }),
    'Mix/1.flac': song({
      title: 'Night Bus',
      artists: ['Low Orbit'],
      album: 'City Mix',
      compilation: true,
    }),
  })
  const { files } = testLocalFiles({ pickDirectory: async () => asHandle(folder) })
  const result = await files.addFolder()
  if (result.status !== 'added') throw new Error(result.status)
  await files.whenScanned(result.root.id)
  return createLocalMetadataProvider(() => files)
}

describe('the local metadata provider', () => {
  it('is the local source', async () => {
    expect((await provider()).id).toBe('local')
  })

  it('searches songs, albums and artists of local files', async () => {
    const local = await provider()
    const results = await local.search(
      'night',
      { types: ['track', 'album', 'artist', 'playlist', 'video'] },
      CONTEXT,
    )
    expect(results.tracks?.items.map((track) => track.title)).toEqual(['Night Bus', 'Night Drive'])
    expect(results.albums?.items.map((album) => album.name)).toEqual(['City Mix', 'Neon Rivers'])
    expect(results.artists?.items.map((artist) => artist.name)).toEqual([
      'Low Orbit',
      'Various artists',
      'Aria Vale',
    ])
    expect(results.playlists).toEqual({ items: [] })
    expect(results.videos).toEqual({ items: [] })
  })

  it('answers only the types asked for, a page at a time', async () => {
    const local = await provider()
    const first = await local.search('a', { types: ['track'], limit: 2 }, CONTEXT)
    expect(Object.keys(first)).toEqual(['tracks'])
    expect(first.tracks?.items).toHaveLength(2)
    expect(first.tracks?.total).toBe(4)
    const cursor = first.tracks?.nextCursor
    expect(cursor).toBe('2')
    const second = await local.search(
      'a',
      { types: ['track'], limit: 2, ...(cursor ? { cursor } : {}) },
      CONTEXT,
    )
    expect(second.tracks?.items).toHaveLength(2)
    expect(second.tracks?.nextCursor).toBeUndefined()
  })

  it('loads a local album in track order, with its year', async () => {
    const local = await provider()
    const album = await local.getAlbum(localAlbumId('Aria Vale', 'Neon Rivers'), CONTEXT)
    expect(album).toMatchObject({
      source: 'local',
      name: 'Neon Rivers',
      artists: [{ name: 'Aria Vale' }],
      releaseDate: '2021',
      trackCount: 2,
    })
    expect(album.tracks?.map((track) => track.title)).toEqual(['Night Drive', 'Slow Tide'])
  })

  it('loads a local artist with their songs and albums', async () => {
    const local = await provider()
    const artist = await local.getArtist(localArtistId('aria vale'), CONTEXT)
    expect(artist.name).toBe('Aria Vale')
    expect(artist.topTracks?.map((track) => track.title)).toEqual([
      'Night Drive',
      'Slow Tide',
      'First Light',
    ])
    expect(artist.albums?.map((album) => album.name)).toEqual(['Neon Rivers', 'Older Songs'])
    const featured = await local.getArtist(localArtistId('Theo Marsh'), CONTEXT)
    expect(featured.topTracks?.map((track) => track.title)).toEqual(['Slow Tide'])
    expect(featured.albums).toEqual([])
  })

  it('loads a track by ID', async () => {
    const local = await provider()
    const [track] =
      (await local.search('first light', { types: ['track'] }, CONTEXT)).tracks?.items ?? []
    expect(track).toBeDefined()
    expect(await local.getTrack(track?.id ?? localTrackId('x'), CONTEXT)).toEqual(track)
  })

  it('rejects unknown IDs and every playlist as NotFound', async () => {
    const local = await provider()
    const failures = await Promise.all([
      local.getTrack(localTrackId('nope'), CONTEXT).catch((error: unknown) => error),
      local.getAlbum(localAlbumId('No', 'One'), CONTEXT).catch((error: unknown) => error),
      local.getArtist(localArtistId('Nobody'), CONTEXT).catch((error: unknown) => error),
      local.getPlaylist('local:playlist:liked' as never, CONTEXT).catch((error: unknown) => error),
    ])
    for (const failure of failures) expect(isFxmError(failure, 'NotFound')).toBe(true)
  })
})

describe('pageOf', () => {
  it('pages by offset', () => {
    const items = [1, 2, 3, 4, 5]
    expect(pageOf(items, { limit: 2 })).toEqual({ items: [1, 2], total: 5, nextCursor: '2' })
    expect(pageOf(items, { limit: 2, cursor: '4' })).toEqual({ items: [5], total: 5 })
    expect(pageOf(items, { cursor: 'junk' })).toEqual({ items, total: 5 })
  })
})
