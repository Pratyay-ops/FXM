import { describe, expect, expectTypeOf, it } from 'vitest'
import { FxmError } from './errors'
import { type EntityId, formatId, parseId } from './ids'
import { applyModeFilter, filterPlayable, isPlayable, isVideoKind } from './mode'
import { isTrackSeed, type SearchResults, type SearchType, type Track } from './model'
import type {
  AbortSignalLike,
  AccountProvider,
  AudioCandidate,
  AudioSource,
  Fetch,
  JsonObject,
  LyricsProvider,
  MetadataProvider,
  MinimalAbortSignal,
  MinimalFetch,
  NetworkCapabilities,
  ProviderContext,
  RadioSeed,
  RecommendationProvider,
  SpotifyAccess,
  StreamOption,
  YouTubeAccess,
} from './providers'
import {
  compareStreams,
  DEFAULT_QUALITY_PREFS,
  type FullLengthCheck,
  pickStream,
  tierOf,
} from './quality'

const song: Track = {
  id: formatId('ytm', 'track', 'song1'),
  source: 'ytm',
  title: 'Song',
  artists: [{ name: 'Artist' }],
  artwork: [],
  kind: 'song',
}
const video: Track = { ...song, id: formatId('yt', 'track', 'vid1'), source: 'yt', kind: 'video' }

/** A fetch that answers every request with `body` as JSON and records the URLs. */
function fakeFetch(body: unknown, urls: string[] = []): Fetch {
  return async (input) => {
    urls.push(input)
    const text = JSON.stringify(body)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: input,
      headers: { get: () => 'application/json' },
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }
}

/** The web app's Lite tier: YouTube calls work, its media bytes cannot be read, no Spotify. */
const LITE: NetworkCapabilities = {
  youtube: 'simple',
  spotify: 'unreachable',
  mediaBytes: false,
  fileSystem: false,
}

/** The web app with FXM Connect: everything, including the media bytes. */
const CONNECT: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'anonymous',
  mediaBytes: true,
  fileSystem: false,
}

function context(
  mode: ProviderContext['mode'],
  fetch: Fetch = fakeFetch({}),
  capabilities: NetworkCapabilities = LITE,
): ProviderContext {
  return { fetch, platform: 'web', capabilities, mode }
}

/** An in-memory catalog implementing the provider interfaces. */
const catalog: MetadataProvider & RecommendationProvider = {
  id: 'ytm',
  async search(query, options, ctx) {
    if (ctx.capabilities.youtube === 'none') throw new FxmError('Unsupported', 'No YouTube here')
    const matches = [song, video].filter((track) => track.title.includes(query))
    const limit = options.limit ?? 20
    const results: SearchResults = {}
    if (options.types.includes('track')) {
      results.tracks = { items: matches.filter((track) => track.kind === 'song').slice(0, limit) }
    }
    if (options.types.includes('video')) {
      const videos = ctx.mode === 'all' ? matches.filter((track) => isVideoKind(track.kind)) : []
      results.videos = { items: videos.slice(0, limit) }
    }
    return results
  },
  async suggest(query) {
    return query === '' ? [] : [`${query} remix`, `${query} live`]
  },
  async getTrack(id) {
    const track = [song, video].find((candidate) => candidate.id === id)
    if (!track) throw new FxmError('NotFound', `No track ${id}`)
    return track
  },
  async getAlbum(id) {
    return { id, source: 'ytm', name: 'Album', artists: [], artwork: [], tracks: [song] }
  },
  async getArtist(id) {
    return { id, source: 'ytm', name: 'Artist', artwork: [] }
  },
  async getPlaylist(id) {
    return { id, source: 'ytm', name: 'Playlist', artwork: [], tracks: { items: [song] } }
  },
  async radio(seed, ctx) {
    const seedId = youtubeIdOf(seed)
    if (seedId === undefined) throw new FxmError('Unsupported', 'The seed has no YouTube ID')
    const tracks = applyModeFilter([song, video], ctx.mode)
    return tracks.filter((track) => parseId(track.id).nativeId !== seedId)
  },
}

/** A seed's YouTube ID: its own ID when it is a YouTube one, else a track's external ID. */
function youtubeIdOf(seed: RadioSeed): string | undefined {
  const own = seed.id === undefined ? undefined : parseId(seed.id)
  if (own?.source === 'ytm' || own?.source === 'yt') return own.nativeId
  return isTrackSeed(seed) ? seed.externalIds?.ytm : undefined
}

/** A format in the fake player response. `capped` stands in for what an end-of-file probe finds. */
type FakeFormat = {
  itag: number
  codec: 'opus' | 'aac'
  bitrate: number
  muxed?: boolean
  capped?: boolean
}

/** What an end-of-file range probe says about a URL, where the bytes can be read at all. */
function probe(capped: boolean, ctx: ProviderContext): FullLengthCheck {
  if (!ctx.capabilities.mediaBytes) return 'unverified'
  return capped ? 'capped' : 'verified'
}

const youtubeAudio: AudioSource = {
  id: 'ytm',
  async match(track) {
    return [
      {
        source: 'ytm',
        ref: parseId(track.id).nativeId,
        kind: 'song',
        title: track.title,
        artists: track.artists.map((artist) => artist.name),
        confidence: 0.98,
        evidence: ['title 1.00', 'duration -0.4s'],
      },
    ]
  },
  async resolve(candidate, ctx) {
    const response = await ctx.fetch(`https://example.test/player?v=${candidate.ref}`)
    const { formats } = (await response.json()) as { formats: FakeFormat[] }
    const options = formats.map(
      ({ itag, codec, bitrate, muxed = false, capped = false }): StreamOption => ({
        url: `https://example.test/${candidate.ref}/${itag}`,
        codec,
        container: codec === 'opus' ? 'webm' : 'mp4',
        media: muxed ? 'muxed-video' : 'audio',
        bitrateKbps: bitrate,
        tier: tierOf({ codec, bitrateKbps: bitrate }),
        protocol: 'progressive',
        expiresAt: Date.now() + 6 * 3_600_000,
        ipBound: true,
        fullLength: probe(capped, ctx),
      }),
    )
    // Every usable option, best first; the caller applies the preferences.
    return options.sort(compareStreams)
  },
}

/** Offers a music video itself only where the mode plays videos, and its song everywhere. */
const videoAwareAudio: AudioSource = {
  id: 'ytm',
  async match(track, ctx) {
    const self: AudioCandidate = {
      source: 'ytm',
      ref: parseId(track.id).nativeId,
      kind: track.kind,
      title: track.title,
      artists: track.artists.map((artist) => artist.name),
      confidence: 1,
      evidence: ['same video'],
    }
    const song: AudioCandidate = {
      ...self,
      ref: 'song1',
      kind: 'song',
      confidence: 0.91,
      evidence: ['title 0.97', 'artist 1.00'],
    }
    return filterPlayable([self, song], ctx.mode)
  },
  async resolve() {
    return []
  },
}

const lyrics: LyricsProvider = {
  id: 'lrclib',
  async getLyrics(track) {
    return track.kind === 'song'
      ? { synced: true, lines: [{ timeMs: 0, text: 'La la' }], source: 'lrclib' }
      : null
  },
}

const account: AccountProvider = {
  id: 'spotify',
  async status() {
    return { connected: false }
  },
}

describe('provider interfaces', () => {
  it('search and radio respect the catalog mode through the context', async () => {
    const types = ['track', 'video'] as const
    const music = await catalog.search('', { types }, context('music'))
    const all = await catalog.search('', { types, limit: 5 }, context('all'))
    const kinds = (results: SearchResults, type: 'tracks' | 'videos') =>
      results[type]?.items.map((track) => track.kind)
    expect([kinds(music, 'tracks'), kinds(music, 'videos')]).toEqual([['song'], []])
    expect([kinds(all, 'tracks'), kinds(all, 'videos')]).toEqual([['song'], ['video']])
    expect(await catalog.search('', { types: ['album'] }, context('all'))).toEqual({})
    const artist = { id: formatId('ytm', 'artist', 'UC1'), name: 'Artist' }
    expect(await catalog.radio(artist, context('music'))).toEqual([song])
  })

  it('takes radio seeds from other sources through their external IDs', async () => {
    const spotifyTrack: Track = {
      ...song,
      id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
      source: 'spotify',
    }
    const matched: Track = { ...spotifyTrack, externalIds: { ytm: 'song1' } }
    expect(isTrackSeed(matched)).toBe(true)
    expect(await catalog.radio(matched, context('all'))).toEqual([video])
    expect(await catalog.radio(video, context('all'))).toEqual([song])
    await expect(catalog.radio(spotifyTrack, context('all'))).rejects.toMatchObject({
      code: 'Unsupported',
    })
    await expect(catalog.radio({ name: 'Artist' }, context('all'))).rejects.toMatchObject({
      code: 'Unsupported',
    })
  })

  it('read how far the platform reaches YouTube from the context', async () => {
    const plainPage: NetworkCapabilities = { ...LITE, youtube: 'none' }
    await expect(
      catalog.search('', { types: ['track'] }, context('music', fakeFetch({}), plainPage)),
    ).rejects.toMatchObject({ code: 'Unsupported' })
    const results = await catalog.search('', { types: ['track'] }, context('music'))
    expect(results.tracks?.items).toEqual([song])
  })

  it('suggests queries when the provider can', async () => {
    expect(await catalog.suggest?.('never', context('music'))).toEqual([
      'never remix',
      'never live',
    ])
    expectTypeOf<SearchType>().toEqualTypeOf<'track' | 'album' | 'artist' | 'playlist' | 'video'>()
  })

  it('loads entities by typed ID and rejects unknown ones with FxmError', async () => {
    expect(await catalog.getTrack(song.id, context('all'))).toBe(song)
    await expect(
      catalog.getTrack(formatId('ytm', 'track', 'missing'), context('all')),
    ).rejects.toMatchObject({ code: 'NotFound' })
    const album = await catalog.getAlbum(formatId('ytm', 'album', 'a1'), context('all'))
    const artist = await catalog.getArtist(formatId('ytm', 'artist', 'r1'), context('all'))
    const playlist = await catalog.getPlaylist(formatId('ytm', 'playlist', 'p1'), context('all'))
    expect([album.tracks?.length, artist.name, playlist.tracks?.items.length]).toEqual([
      1,
      'Artist',
      1,
    ])
  })

  it('matches then resolves audio through the injected fetch', async () => {
    const urls: string[] = []
    const formats = [
      { itag: 249, codec: 'opus', bitrate: 50 },
      { itag: 140, codec: 'aac', bitrate: 128 },
      { itag: 251, codec: 'opus', bitrate: 141 },
    ]
    const ctx = context('music', fakeFetch({ formats }, urls))
    const [candidate] = await youtubeAudio.match(song, ctx)
    if (!candidate) throw new Error('expected a candidate')
    const options = await youtubeAudio.resolve(candidate, ctx, DEFAULT_QUALITY_PREFS)
    expect(urls).toEqual(['https://example.test/player?v=song1'])
    expect(options.map((option) => option.url.split('/').at(-1))).toEqual(['251', '140', '249'])
    expect(options[0]).toMatchObject({ codec: 'opus', tier: 'high', ipBound: true })
    // The Lite tier cannot read the bytes, so nothing was probed.
    expect(options.every((option) => option.fullLength === 'unverified')).toBe(true)
    expect(options.every((option) => option.media === 'audio')).toBe(true)
    // Playback applies the tier ceiling of the current connection to the full list.
    expect(pickStream(options, DEFAULT_QUALITY_PREFS.streaming.wifi)?.url).toMatch(/251$/)
    expect(pickStream(options, 'low')?.url).toMatch(/249$/)
  })

  it('probes where the bytes are readable and never chooses a capped URL', async () => {
    const formats: FakeFormat[] = [
      { itag: 251, codec: 'opus', bitrate: 141, capped: true },
      { itag: 140, codec: 'aac', bitrate: 128 },
      { itag: 18, codec: 'aac', bitrate: 96, muxed: true },
    ]
    const ctx = context('music', fakeFetch({ formats }), CONNECT)
    const [candidate] = await youtubeAudio.match(song, ctx)
    if (!candidate) throw new Error('expected a candidate')
    const options = await youtubeAudio.resolve(candidate, ctx, DEFAULT_QUALITY_PREFS)
    const summary = options.map((option) => [option.url.split('/').at(-1), option.fullLength])
    expect(summary).toEqual([
      ['140', 'verified'],
      ['18', 'verified'],
      ['251', 'capped'],
    ])
    // Neither playback nor a download, which wants the best option, gets the capped Opus.
    expect(pickStream(options, 'high')?.url).toMatch(/140$/)
    expect(pickStream(options, 'lossless')?.url).toMatch(/140$/)
  })

  it('falls back to the audio track of muxed itag 18 when every audio URL is capped', async () => {
    const formats: FakeFormat[] = [
      { itag: 251, codec: 'opus', bitrate: 141, capped: true },
      { itag: 140, codec: 'aac', bitrate: 128, capped: true },
      { itag: 18, codec: 'aac', bitrate: 96, muxed: true },
    ]
    const ctx = context('music', fakeFetch({ formats }), CONNECT)
    const [candidate] = await youtubeAudio.match(song, ctx)
    if (!candidate) throw new Error('expected a candidate')
    const options = await youtubeAudio.resolve(candidate, ctx, DEFAULT_QUALITY_PREFS)
    const fallback = pickStream(options, 'high')
    expect(fallback).toMatchObject({ media: 'muxed-video', codec: 'aac', container: 'mp4' })
    // Its tier is the AAC track's, whatever the video adds.
    expect(fallback?.tier).toBe('normal')
    expect(pickStream(options, 'low')).toBe(fallback)
    const allCapped = options.map((option): StreamOption => ({ ...option, fullLength: 'capped' }))
    expect(pickStream(allCapped, 'high')).toBeUndefined()
  })

  it('never returns a candidate that the mode cannot play as it is', async () => {
    const officialVideo: Track = {
      ...song,
      id: formatId('ytm', 'track', 'omv1'),
      kind: 'music-video',
    }
    const music = await videoAwareAudio.match(officialVideo, context('music'))
    const all = await videoAwareAudio.match(officialVideo, context('all'))
    expect(music.map((candidate) => candidate.ref)).toEqual(['song1'])
    expect(all.map((candidate) => candidate.ref)).toEqual(['omv1', 'song1'])
    expect(music.every((candidate) => isPlayable(candidate, 'music'))).toBe(true)
  })

  it('finds lyrics and account status', async () => {
    expect((await lyrics.getLyrics(song, context('all')))?.synced).toBe(true)
    expect(await lyrics.getLyrics(video, context('all'))).toBeNull()
    expect(await account.status(context('all'))).toEqual({ connected: false })
  })

  it('types IDs, candidates and the platform hooks', () => {
    expectTypeOf<Parameters<MetadataProvider['getAlbum']>[0]>().toEqualTypeOf<EntityId<'album'>>()
    expectTypeOf<AudioCandidate['confidence']>().toEqualTypeOf<number>()
    // @fxm/core loads only the ES library, so here the platform types use their fallbacks.
    // In programs with DOM, web worker or Node types they are exactly `typeof fetch` and
    // `AbortSignal`, as type-tests/platform.ts checks.
    expectTypeOf<Fetch>().toEqualTypeOf<MinimalFetch>()
    expectTypeOf<AbortSignalLike>().toEqualTypeOf<MinimalAbortSignal>()
  })
})

describe('network capabilities', () => {
  it('grade YouTube and Spotify instead of a yes or no', () => {
    expectTypeOf<YouTubeAccess>().toEqualTypeOf<'none' | 'simple' | 'full'>()
    expectTypeOf<SpotifyAccess>().toEqualTypeOf<'unreachable' | 'anonymous' | 'account'>()
    expectTypeOf<NetworkCapabilities['youtube']>().toEqualTypeOf<YouTubeAccess>()
    expectTypeOf<NetworkCapabilities['spotify']>().toEqualTypeOf<SpotifyAccess>()
    // @ts-expect-error a boolean no longer says how far YouTube can be reached
    const yesOrNo: NetworkCapabilities = { ...LITE, youtube: true }
    expect(yesOrNo.youtube).toBe(true)
  })
})

describe('stream options', () => {
  /** What a SABR resolver might hand its player, declared as a type alias. */
  type SabrSession = {
    ustreamerConfig: string
    poToken?: string
    client: { name: string; version: string }
    formats: Array<{ itag: number; lastModified: string }>
  }

  const session: SabrSession = {
    ustreamerConfig: 'CgIQBg',
    client: { name: 'WEB', version: '2.20261020' },
    formats: [{ itag: 251, lastModified: '1700000000000000' }],
  }

  const sabr: StreamOption = {
    url: 'https://example.test/sabr?expire=1',
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 141,
    tier: 'high',
    protocol: 'sabr',
    ipBound: true,
    fullLength: 'unverified',
    playback: session,
  }

  it('must say whether the URL delivers the whole file and what the file holds', () => {
    expectTypeOf<StreamOption['fullLength']>().toEqualTypeOf<'verified' | 'unverified' | 'capped'>()
    expectTypeOf<StreamOption['media']>().toEqualTypeOf<'audio' | 'muxed-video'>()
    const { fullLength: _fullLength, ...withoutLength } = sabr
    // @ts-expect-error every resolver says whether the URL delivers the whole file
    const unprobed: StreamOption = withoutLength
    const { media: _media, ...withoutMedia } = sabr
    // @ts-expect-error every resolver says whether the file is audio or a muxed video
    const unlabelled: StreamOption = withoutMedia
    expect([unprobed.fullLength, unlabelled.media]).toEqual([undefined, undefined])
  })

  it('carry the protocol data of a SABR stream as JSON', () => {
    expect(JSON.parse(JSON.stringify(sabr))).toEqual(sabr)
    expectTypeOf<SabrSession>().toExtend<JsonObject>()
  })

  it('accept only JSON in the protocol data', () => {
    // @ts-expect-error a function does not survive JSON
    const withFunction: StreamOption = { ...sabr, playback: { ready: () => true } }
    // @ts-expect-error neither do bytes
    const withBytes: StreamOption = { ...sabr, playback: { init: new Uint8Array(2) } }
    expect([withFunction.playback, withBytes.playback]).toHaveLength(2)
  })
})
