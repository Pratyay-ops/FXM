import {
  DEFAULT_PLAYBACK_SETTINGS,
  FxmError,
  formatId,
  type PlaybackSettings,
  playbackProblemOf,
  type StreamOption,
  sanitizeQualityPrefs,
} from '@fxm/core'
import { createMemoryMatchStore } from '@fxm/player'
import {
  FakeMatcher,
  FakeStreamSource,
  ladderStreams,
  testCandidate,
  testContext,
  testSpotifyTrack,
  testTrack,
} from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import {
  createPolicyDownloadResolver,
  type DownloadResolveRequest,
  NoDownloadableStreamError,
  type PolicyDownloadResolverOptions,
} from './resolver'

function request(overrides: Partial<DownloadResolveRequest> = {}): DownloadResolveRequest {
  return {
    ctx: testContext('full'),
    prefs: sanitizeQualityPrefs(undefined),
    reason: 'start',
    attempt: 0,
    exclude: new Set(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

function setup(
  options: Partial<PolicyDownloadResolverOptions> & { settings?: () => PlaybackSettings } = {},
) {
  const youtube = new FakeStreamSource({ now: () => 0 })
  const matcher = new FakeMatcher()
  const matches = createMemoryMatchStore()
  const resolver = createPolicyDownloadResolver({
    sources: [youtube],
    matcher,
    matches,
    now: () => Date.UTC(2026, 9, 26),
    ...options,
  })
  return { youtube, matcher, matches, resolver }
}

const flacStream = (ref: string): StreamOption => ({
  url: `https://archive.test/${ref}`,
  codec: 'flac',
  container: 'flac',
  media: 'audio',
  tier: 'lossless',
  bitrateKbps: 900,
  protocol: 'progressive',
  ipBound: false,
  fullLength: 'unverified',
})

describe('the policy download resolver', () => {
  it("downloads a YouTube Music song's best verified stream", async () => {
    const { resolver, youtube } = setup()
    const { candidate, stream } = await resolver.resolve(testTrack('a'), request())
    expect(candidate).toMatchObject({ source: 'ytm', ref: 'a' })
    expect(stream).toMatchObject({
      url: 'https://media.test/a/251?n=1',
      codec: 'opus',
      fullLength: 'verified',
    })
    expect(youtube.log).toEqual(['a:top'])
    expect(youtube.calls[0]?.request.priority).toBe('prefetch')
  })

  it('never downloads YouTube audio in the Lite tier', async () => {
    const { resolver, youtube } = setup()
    await expect(
      resolver.resolve(testTrack('a'), request({ ctx: testContext('lite') })),
    ).rejects.toMatchObject({ code: 'Unsupported' })
    expect(youtube.calls).toHaveLength(0)
  })

  it("falls back to itag 18 when the top rung's URLs are capped", async () => {
    const { resolver, youtube } = setup()
    youtube.capped.add('a')
    const { stream } = await resolver.resolve(testTrack('a'), request())
    expect(stream).toMatchObject({ url: 'https://media.test/a/18?n=2', media: 'muxed-video' })
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
  })

  it('refuses YouTube URLs that did not pass the end-of-file probe', async () => {
    const { resolver, youtube } = setup()
    // A probe that failed CORS after a googlevideo redirect leaves the URLs unverified.
    youtube.handler = async (candidate, { rung }) =>
      ladderStreams(candidate.ref, { rung, fullLength: 'unverified', serial: youtube.calls.length })
    const error = await resolver.resolve(testTrack('a'), request()).catch((caught) => caught)
    expect(error).toBeInstanceOf(NoDownloadableStreamError)
    expect(error).toMatchObject({ reason: 'unverified' })
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
  })

  it('never hands out a URL that failed', async () => {
    const { resolver } = setup()
    const exclude = new Set(['https://media.test/a/251?n=1'])
    const { stream } = await resolver.resolve(testTrack('a'), request({ exclude }))
    expect(stream.url).toBe('https://media.test/a/140?n=1')
  })

  it('keeps the format of the stored bytes on a resume', async () => {
    const { resolver } = setup()
    const format = { codec: 'aac', container: 'm4a', media: 'audio', tier: 'high' } as const
    const { stream } = await resolver.resolve(testTrack('a'), request({ reason: 'resume', format }))
    expect(stream).toMatchObject({ codec: 'aac', container: 'm4a' })
  })

  it('prefers a stream this device can play, so the copy plays offline here', async () => {
    const { resolver } = setup({
      canPlay: (stream) => (stream.codec === 'opus' ? 'no' : 'probably'),
    })
    const { stream } = await resolver.resolve(testTrack('a'), request())
    expect(stream.codec).toBe('aac')
  })

  it('resolves the audio a resumed download came from first', async () => {
    const { resolver, matcher, youtube } = setup()
    const track = testSpotifyTrack('hit')
    const { candidate } = await resolver.resolve(
      track,
      request({ reason: 'resume', candidate: testCandidate('m') }),
    )
    expect(candidate.ref).toBe('m')
    expect(matcher.calls).toHaveLength(0)
    expect(youtube.log).toEqual(['m:top'])
  })

  it("downloads a Spotify track's Auto match, and stores the match", async () => {
    const { resolver, matcher, matches } = setup()
    const track = testSpotifyTrack('hit')
    matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    const { candidate } = await resolver.resolve(track, request())
    expect(candidate.ref).toBe('m')
    expect(await matches.get({ trackId: track.id, mode: 'music', target: 'song' })).toMatchObject({
      band: 'auto',
      pinned: false,
    })
    // The stored match serves the next download.
    await resolver.resolve(track, request())
    expect(matcher.calls).toHaveLength(1)
  })

  it('never downloads a best guess, unless "Play best guesses" is on', async () => {
    const track = testSpotifyTrack('hit')
    const guess = { candidate: testCandidate('m'), band: 'suggest' } as const
    const strict = setup()
    strict.matcher.rank(track, 'song', [guess])
    const error = await strict.resolver.resolve(track, request()).catch((caught) => caught)
    expect(playbackProblemOf(error)).toMatchObject({ type: 'needs-review' })
    expect(strict.youtube.calls).toHaveLength(0)
    const relaxed = setup({
      settings: () => ({ ...DEFAULT_PLAYBACK_SETTINGS, playBestGuesses: true }),
    })
    relaxed.matcher.rank(track, 'song', [guess])
    expect((await relaxed.resolver.resolve(track, request())).candidate.ref).toBe('m')
  })

  it("downloads the user's pinned version", async () => {
    const { resolver, matcher, matches } = setup()
    const track = testSpotifyTrack('hit')
    await matches.put(
      { trackId: track.id, mode: 'music', target: 'song' },
      {
        band: 'suggest',
        candidate: testCandidate('pin'),
        alternatives: [],
        pinned: true,
        matchedAt: 0,
      },
    )
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('pin')
    expect(matcher.calls).toHaveLength(0)
  })

  it('matches again when a stored match is stale', async () => {
    const { resolver, matcher, matches } = setup()
    const track = testSpotifyTrack('hit')
    await matches.put(
      { trackId: track.id, mode: 'music', target: 'song' },
      {
        band: 'auto',
        candidate: testCandidate('old'),
        alternatives: [],
        pinned: false,
        matchedAt: 0,
      },
    )
    matcher.rank(track, 'song', [{ candidate: testCandidate('new'), band: 'auto' }])
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('new')
  })

  it('downloads a lossless copy first with "prefer lossless" on', async () => {
    const archive = new FakeStreamSource({ id: 'archive', expires: false })
    archive.handler = async (candidate) => [flacStream(candidate.ref)]
    const { resolver, matcher } = setup({
      sources: [new FakeStreamSource({ now: () => 0 }), archive],
      settings: () => ({ ...DEFAULT_PLAYBACK_SETTINGS, preferLossless: true }),
    })
    const track = testSpotifyTrack('hit')
    const flac = testCandidate('item/hit.flac', {
      source: 'archive',
      signals: { isrcVerified: true, sourceAlbumMatch: false },
    })
    matcher.rank(track, 'lossless', [{ candidate: flac, band: 'suggest' }])
    const { candidate, stream } = await resolver.resolve(track, request())
    expect(candidate.source).toBe('archive')
    // Internet Archive never caps its URLs, so an unprobed one is fine.
    expect(stream).toMatchObject({ codec: 'flac', fullLength: 'unverified' })
  })

  it('downloads the song when looking for a lossless copy fails', async () => {
    const { resolver, matcher } = setup({
      settings: () => ({ ...DEFAULT_PLAYBACK_SETTINGS, preferLossless: true }),
    })
    const track = testSpotifyTrack('hit')
    matcher.fail(track, 'lossless', new FxmError('Network', 'quota'))
    matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('m')
  })

  it("downloads a music video's linked song in Music mode", async () => {
    const { resolver } = setup()
    const video = testTrack('video', {
      kind: 'music-video',
      songId: formatId('ytm', 'track', 'song'),
    })
    const { candidate } = await resolver.resolve(video, request())
    expect(candidate).toMatchObject({ ref: 'song', kind: 'song' })
  })

  it('reports audio that is gone, and passing trouble as it came', async () => {
    const { resolver, youtube } = setup()
    youtube.verdicts.set('a', 'UNPLAYABLE')
    const gone = await resolver.resolve(testTrack('a'), request()).catch((caught) => caught)
    expect(playbackProblemOf(gone)).toMatchObject({ type: 'unavailable', reason: 'unplayable' })
    const blip = new FxmError('Network', 'blip')
    youtube.errors.set('b', blip)
    await expect(resolver.resolve(testTrack('b'), request())).rejects.toBe(blip)
    youtube.errors.set('c', new FxmError('BotCheck', 'prove it'))
    await expect(resolver.resolve(testTrack('c'), request())).rejects.toMatchObject({
      code: 'BotCheck',
    })
  })

  it('reports a bot check from the matching engine', async () => {
    const { resolver, matcher } = setup()
    const track = testSpotifyTrack('hit')
    matcher.fail(track, 'song', new FxmError('BotCheck', 'prove it'))
    await expect(resolver.resolve(track, request())).rejects.toMatchObject({ code: 'BotCheck' })
  })

  it('says when nothing can resolve the audio', async () => {
    const { resolver } = setup({ sources: [] })
    const archived = testTrack('x', {
      id: formatId('archive', 'track', 'item/x.mp3'),
      source: 'archive',
    })
    const error = await resolver.resolve(archived, request()).catch((caught) => caught)
    expect(playbackProblemOf(error)).toMatchObject({ type: 'unavailable', reason: 'no-source' })
    const unmatched = createPolicyDownloadResolver({ sources: [new FakeStreamSource()] })
    const noMatch = await unmatched
      .resolve(testSpotifyTrack('hit'), request())
      .catch((caught) => caught)
    expect(playbackProblemOf(noMatch)).toMatchObject({ reason: 'no-match' })
  })

  it('says when no stream can be downloaded', async () => {
    const { resolver, youtube } = setup()
    youtube.handler = async (candidate) =>
      ladderStreams(candidate.ref, { rung: 'top', fullLength: 'verified', serial: 1 }).map(
        (stream) => ({ ...stream, protocol: 'hls' as const }),
      )
    await expect(resolver.resolve(testTrack('a'), request())).rejects.toMatchObject({
      name: 'NoDownloadableStreamError',
      reason: 'no-stream',
    })
  })

  it('stops when aborted', async () => {
    const { resolver } = setup()
    const signal = AbortSignal.abort(new Error('stop'))
    await expect(resolver.resolve(testTrack('a'), request({ signal }))).rejects.toThrow()
  })
})
