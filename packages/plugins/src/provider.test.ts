import { DEFAULT_QUALITY_PREFS, formatId, type QualityPrefs, type Track } from '@fxm/core'
import { createRequestBudget } from '@fxm/platform'
import { createInProcessEvaluator } from '@fxm/platform/testing'
import { describe, expect, it } from 'vitest'
import { createFetchBroker } from './broker'
import { createPluginRunner } from './host'
import { parseManifest } from './manifest'
import { createPluginProviders } from './provider'
import { isolatedSandboxes } from './sandboxes'
import {
  fakeCatalogFetch,
  TEST_CATALOG_HOST,
  TEST_MEDIA_HOST,
  TEST_PLUGIN_CODE,
  testContext,
  testPluginManifest,
} from './testing'

const prefs = DEFAULT_QUALITY_PREFS as QualityPrefs

function providers(manifestOverrides: Record<string, unknown> = {}) {
  const manifest = parseManifest(testPluginManifest(manifestOverrides))
  const runner = createPluginRunner({
    manifest,
    code: TEST_PLUGIN_CODE,
    sandboxes: isolatedSandboxes(() => createInProcessEvaluator()),
    broker: createFetchBroker({
      plugin: manifest,
      budget: createRequestBudget({
        hourlyLimit: 120,
        reserves: { 'current-track': 0, prefetch: 0, interactive: 0, bulk: 0 },
      }),
    }),
  })
  const fetch = fakeCatalogFetch()
  return { ...createPluginProviders(runner), fetch, ctx: testContext(fetch) }
}

const spotifyTrack: Track = {
  id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
  source: 'spotify',
  title: 'Lantern Weather',
  artists: [{ name: 'The Paper Moths' }],
  album: { name: 'Night Ferries' },
  durationMs: 201_000,
  artwork: [],
  kind: 'song',
  isrc: 'ZZTST2600001',
}

describe('plugin providers', () => {
  it('search the plugin’s catalog only when asked explicitly, with FXM’s IDs', async () => {
    const { metadata, fetch, ctx } = providers()
    expect(metadata?.id).toBe('plugin.test-catalog')
    expect(metadata?.requestPolicy).toBe('explicit')
    const results = await metadata?.search('moths', { types: ['track', 'album', 'artist'] }, ctx)
    expect(results?.tracks).toMatchObject({
      items: [
        {
          id: 'plugin.test-catalog:track:t1',
          source: 'plugin.test-catalog',
          title: 'Lantern Weather',
          artists: [{ id: 'plugin.test-catalog:artist:a1', name: 'The Paper Moths' }],
          album: { id: 'plugin.test-catalog:album:al1', name: 'Night Ferries' },
          durationMs: 201_000,
          artwork: [{ url: `https://${TEST_MEDIA_HOST}/covers/al1.jpg`, width: 300, height: 300 }],
          isrc: 'ZZTST2600001',
          kind: 'song',
        },
        { id: 'plugin.test-catalog:track:t2' },
      ],
      nextCursor: 'page-2',
    })
    expect(results?.albums?.items.map((album) => album.id)).toEqual([
      'plugin.test-catalog:album:al1',
    ])
    expect(results?.artists?.items.map((artist) => artist.name)).toEqual(['The Paper Moths'])
    expect(results).not.toHaveProperty('playlists')
    const more = await metadata?.search('moths', { types: ['track'], cursor: 'page-2' }, ctx)
    expect(more?.tracks?.items.map((track) => track.id)).toEqual(['plugin.test-catalog:track:t3'])
    expect(fetch.requests.map((request) => request.url)).toEqual([
      `https://${TEST_CATALOG_HOST}/search?q=moths`,
      `https://${TEST_CATALOG_HOST}/search?q=moths&cursor=page-2`,
    ])
    expect(await metadata?.suggest?.('lan', ctx)).toEqual([
      'lantern weather',
      'lantern weather live',
    ])
  })

  it('load the plugin’s tracks, albums, artists and playlists, page by page', async () => {
    const { metadata, ctx } = providers()
    expect(
      (await metadata?.getTrack(formatId('plugin.test-catalog', 'track', 't3'), ctx))?.title,
    ).toBe('Copper Tide')
    const album = await metadata?.getAlbum(formatId('plugin.test-catalog', 'album', 'al1'), ctx)
    expect(album).toMatchObject({ name: 'Night Ferries', type: 'album', releaseDate: '2026' })
    expect(album?.tracks).toHaveLength(3)
    const artist = await metadata?.getArtist(formatId('plugin.test-catalog', 'artist', 'a1'), ctx)
    expect(artist?.topTracks?.map((track) => track.title)).toEqual([
      'Lantern Weather',
      'Harbour Lights Out',
    ])
    const playlistId = formatId('plugin.test-catalog', 'playlist', 'p1')
    const playlist = await metadata?.getPlaylist(playlistId, ctx)
    expect(playlist).toMatchObject({ name: 'Ferry Songs', tracks: { nextCursor: 'more' } })
    const rest = await metadata?.getPlaylistTracks?.(playlistId, { cursor: 'more' }, ctx)
    expect(rest?.items.map((track) => track.title)).toEqual(['Copper Tide'])
    expect(rest).not.toHaveProperty('nextCursor')
  })

  it('pass on NotFound, and refuse IDs of other sources without asking the plugin', async () => {
    const { metadata, fetch, ctx } = providers()
    await expect(
      metadata?.getTrack(formatId('plugin.test-catalog', 'track', 'nope'), ctx),
    ).rejects.toMatchObject({ code: 'NotFound' })
    const before = fetch.requests.length
    await expect(metadata?.getTrack(spotifyTrack.id, ctx)).rejects.toMatchObject({
      code: 'NotFound',
    })
    expect(fetch.requests).toHaveLength(before)
  })

  it('match its own tracks without a search, and other sources’ tracks through the plugin', async () => {
    const { audio, fetch, ctx } = providers()
    const own = await audio?.match(
      {
        ...spotifyTrack,
        id: formatId('plugin.test-catalog', 'track', 't1'),
        source: 'plugin.test-catalog',
      },
      ctx,
    )
    expect(own).toEqual([
      {
        source: 'plugin.test-catalog',
        ref: 't1',
        kind: 'song',
        title: 'Lantern Weather',
        artists: ['The Paper Moths'],
        durationMs: 201_000,
        confidence: 1,
        evidence: ['same source'],
      },
    ])
    expect(fetch.requests).toEqual([])
    const matched = await audio?.match(spotifyTrack, ctx)
    expect(matched?.[0]).toMatchObject({
      source: 'plugin.test-catalog',
      ref: 't1',
      confidence: 0.9,
      evidence: ['plugin test-catalog'],
    })
    // The plugin learns the title and artists, never another source's ID.
    expect(fetch.requests.map((request) => request.url)).toEqual([
      `https://${TEST_CATALOG_HOST}/search?q=Lantern%20Weather`,
    ])
  })

  it('resolve its candidates to streams on its media host, best first', async () => {
    const { audio, ctx } = providers()
    const own = { ...spotifyTrack, id: formatId('plugin.test-catalog', 'track', 't2') }
    const [candidate] = (await audio?.match({ ...own, source: 'plugin.test-catalog' }, ctx)) ?? []
    if (candidate === undefined) throw new Error('no candidate')
    const streams = await audio?.resolve(candidate, ctx, prefs)
    expect(streams?.map((stream) => [stream.codec, stream.tier, stream.fullLength])).toEqual([
      ['flac', 'lossless', 'unverified'],
      ['mp3', 'high', 'unverified'],
    ])
    expect(streams?.[0]?.url).toBe(`https://${TEST_MEDIA_HOST}/audio/t2.flac`)
    await expect(audio?.resolve({ ...candidate, source: 'ytm' }, ctx, prefs)).rejects.toMatchObject(
      { code: 'Unsupported' },
    )
  })

  it('play radio from a track or an artist', async () => {
    const { recommendations, ctx } = providers()
    expect(recommendations?.id).toBe('plugin.test-catalog')
    const tracks = await recommendations?.radio(spotifyTrack, ctx)
    expect(tracks?.map((track) => track.title)).toEqual(['Harbour Lights Out', 'Copper Tide'])
    const fromArtist = await recommendations?.radio(
      { id: formatId('plugin.test-catalog', 'artist', 'a1'), name: 'The Paper Moths' },
      ctx,
    )
    expect(fromArtist).toHaveLength(2)
  })

  it('provide only what the manifest declares', () => {
    const resolverOnly = providers({ provides: ['match', 'resolve'] })
    expect(resolverOnly.metadata).toBeUndefined()
    expect(resolverOnly.recommendations).toBeUndefined()
    expect(resolverOnly.audio).toBeDefined()
    const sourceOnly = providers({ provides: ['search'] })
    expect(sourceOnly.metadata?.suggest).toBeUndefined()
    expect(sourceOnly.metadata?.getPlaylistTracks).toBeUndefined()
    expect(sourceOnly.audio).toBeUndefined()
  })
})
