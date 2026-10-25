import { FxmError, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createFakeMediaActions } from './fake-actions'
import { createFakeCatalog, fakeIds } from './fake-catalog'
import { createStaticPlatform, TIER_CAPABILITIES } from './sources'

const platform = createStaticPlatform(TIER_CAPABILITIES.full)
const ctx = (mode: ProviderContext['mode'] = 'music', signal?: AbortSignal): ProviderContext =>
  platform.context({ mode, ...(signal ? { signal } : {}) })

describe('the fake catalog', () => {
  it('searches each requested type, one page each', async () => {
    const catalog = createFakeCatalog('ytm')
    const results = await catalog.search('harbor', { types: ['track', 'album'] }, ctx())
    expect(results.tracks?.items.map((track) => track.title)).toEqual(
      expect.arrayContaining(['Harbor Lights']),
    )
    expect(results.tracks?.items.every((track) => track.kind === 'song')).toBe(true)
    expect(results.albums?.items.map((album) => album.name)).toEqual(['Neon Harbor'])
    expect(results.albums?.items[0]).not.toHaveProperty('tracks')
    expect(results).not.toHaveProperty('artists')
  })

  it('finds videos only in Music + Video mode, and only on YouTube Music', async () => {
    const ytm = createFakeCatalog('ytm')
    expect(
      (await ytm.search('paper moons', { types: ['video'] }, ctx('music'))).videos?.items,
    ).toEqual([])
    const videos = (await ytm.search('paper moons', { types: ['video'] }, ctx('all'))).videos?.items
    expect(videos?.map((video) => video.kind)).toEqual(['music-video', 'video'])
    expect(videos?.[0]?.songId).toBe(fakeIds.track('ytm', 'neon-harbor-3'))
    const spotify = createFakeCatalog('spotify')
    expect((await spotify.search('paper', { types: ['video'] }, ctx('all'))).videos?.items).toEqual(
      [],
    )
  })

  it('pages with cursors', async () => {
    const catalog = createFakeCatalog('ytm')
    const first = await catalog.search('e', { types: ['track'], limit: 20 }, ctx())
    expect(first.tracks?.items).toHaveLength(20)
    expect(first.tracks?.nextCursor).toBe('20')
    const second = await catalog.search(
      'e',
      { types: ['track'], limit: 20, cursor: first.tracks?.nextCursor ?? '' },
      ctx(),
    )
    expect(second.tracks?.items[0]).not.toEqual(first.tracks?.items[0])
    expect(catalog.calls.map((call) => call.cursor)).toEqual([undefined, '20'])
  })

  it('suggests completions, best first, without the query itself', async () => {
    const catalog = createFakeCatalog('ytm')
    const suggestions = await catalog.suggest?.('neon', ctx())
    expect(suggestions?.[0]).toMatch(/^neon/)
    expect(suggestions).toContain('neon harbor')
    expect(await catalog.suggest?.('neon harbor', ctx())).not.toContain('neon harbor')
  })

  it('suggests only as YouTube Music, as among the real providers', () => {
    expect(createFakeCatalog('ytm').suggest).toBeTypeOf('function')
    for (const source of ['spotify', 'archive', 'jamendo'] as const) {
      expect(createFakeCatalog(source).suggest).toBeUndefined()
    }
  })

  it('loads albums, artists and playlists, filtered for the mode', async () => {
    const catalog = createFakeCatalog('ytm')
    const album = await catalog.getAlbum(fakeIds.album('ytm', 'neon-harbor'), ctx())
    expect(album.tracks).toHaveLength(10)

    const artist = await catalog.getArtist(fakeIds.artist('ytm', 'nova-lane'), ctx())
    expect(artist.topTracks?.length).toBeGreaterThan(0)
    expect(artist.albums?.map((release) => release.type)).toEqual(['album', 'ep', 'single'])
    expect(artist.related?.map((other) => other.name)).toContain('The Midnight Owls')

    const drive = fakeIds.playlist('ytm', 'late-night-drive')
    const music = await catalog.getPlaylist(drive, ctx('music'))
    const all = await catalog.getPlaylist(drive, ctx('all'))
    expect(music.tracks?.items.some((track) => track.kind === 'video')).toBe(false)
    expect(all.tracks?.items.some((track) => track.kind === 'video')).toBe(true)
  })

  it('pages long playlists', async () => {
    const catalog = createFakeCatalog('spotify')
    const id = fakeIds.playlist('spotify', 'indie-sunrise')
    const playlist = await catalog.getPlaylist(id, ctx())
    expect(playlist.trackCount).toBe(120)
    expect(playlist.tracks?.items).toHaveLength(50)
    const next = await catalog.getPlaylistTracks?.(
      id,
      { cursor: playlist.tracks?.nextCursor ?? '' },
      ctx(),
    )
    expect(next?.items).toHaveLength(50)
    expect(next?.nextCursor).toBe('100')
  })

  it('leaves similar artists to getRelatedArtists on Spotify', async () => {
    const catalog = createFakeCatalog('spotify')
    const id = fakeIds.artist('spotify', 'nova-lane')
    expect(await catalog.getArtist(id, ctx())).not.toHaveProperty('related')
    const related = await catalog.getRelatedArtists?.(id, ctx())
    expect(related?.map((artist) => artist.name)).toContain('Aurora Fields')
  })

  it('rejects unknown IDs with NotFound, and fails on demand', async () => {
    const catalog = createFakeCatalog('ytm')
    await expect(catalog.getAlbum(fakeIds.album('ytm', 'nope'), ctx())).rejects.toMatchObject({
      code: 'NotFound',
    })
    catalog.fail('search', new FxmError('RateLimited', 'slow down'))
    await expect(catalog.search('owl', { types: ['track'] }, ctx())).rejects.toMatchObject({
      code: 'RateLimited',
    })
    catalog.fail('search', undefined)
    await expect(catalog.search('owl', { types: ['track'] }, ctx())).resolves.toBeDefined()
  })

  it('stops waiting when the call is aborted', async () => {
    const catalog = createFakeCatalog('ytm', { latencyMs: 10_000 })
    const controller = new AbortController()
    const call = catalog.search('owl', { types: ['track'] }, ctx('music', controller.signal))
    controller.abort(new DOMException('Aborted', 'AbortError'))
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the fake actions', () => {
  it('record what they are asked and keep an in-memory library', async () => {
    const said: string[] = []
    const actions = createFakeMediaActions({ onAction: (what) => said.push(what) })
    const catalog = createFakeCatalog('ytm')
    const album = await catalog.getAlbum(fakeIds.album('ytm', 'owl-hours'), ctx())
    const tracks = album.tracks ?? []

    actions.playback.play(tracks, { shuffle: true })
    actions.playback.addToQueue(tracks.slice(0, 2))
    await actions.library.addToPlaylist('workout', tracks)
    const created = await actions.library.createPlaylist('Owls', tracks.slice(0, 1))

    expect(actions.log.map((entry) => entry.action)).toEqual([
      'play',
      'addToQueue',
      'addToPlaylist',
      'createPlaylist',
    ])
    expect(said[0]).toBe('shuffling Owl Hours')
    const playlists = await actions.library.playlists()
    expect(playlists.find((playlist) => playlist.id === 'workout')?.trackCount).toBe(
      18 + tracks.length,
    )
    expect(playlists).toContainEqual(created)
    await expect(actions.library.addToPlaylist('nope', tracks)).rejects.toThrow()
  })
})
