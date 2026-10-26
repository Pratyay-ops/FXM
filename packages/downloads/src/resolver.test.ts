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
    // Background work: the request budget spaces it out and stops it before search runs dry.
    expect(youtube.calls[0]?.request.priority).toBe('bulk')
  })

  it('resolves and matches at the priority it is given', async () => {
    const { resolver, youtube, matcher } = setup({ priority: 'prefetch' })
    await resolver.resolve(testTrack('a'), request())
    expect(youtube.calls[0]?.request.priority).toBe('prefetch')
    const track = testSpotifyTrack('hit')
    matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    await resolver.resolve(track, request())
    expect(matcher.calls[0]?.request.priority).toBe('prefetch')
    // And at the bulk priority by default.
    const plain = setup()
    plain.matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    await plain.resolver.resolve(track, request())
    expect(plain.matcher.calls[0]?.request.priority).toBe('bulk')
  })

  it('says which tracks it can resolve: those its sources cover', () => {
    const archive = testTrack('a.flac', {
      id: formatId('archive', 'track', 'item/a.flac'),
      source: 'archive',
    })
    const jamendo = testTrack('j', { id: formatId('jamendo', 'track', '1'), source: 'jamendo' })
    const { resolver } = setup()
    expect(resolver.canResolve?.(testTrack('a'))).toBe(true)
    expect(resolver.canResolve?.(testSpotifyTrack('hit'))).toBe(true)
    expect(resolver.canResolve?.(archive)).toBe(false)
    expect(resolver.canResolve?.(jamendo)).toBe(false)
    const none = createPolicyDownloadResolver({ sources: [] })
    expect(none.canResolve?.(testTrack('a'))).toBe(false)
    const free = createPolicyDownloadResolver({
      sources: [new FakeStreamSource({ id: 'archive' })],
    })
    expect(free.canResolve?.(archive)).toBe(true)
    expect(free.canResolve?.(testTrack('a'))).toBe(false)
  })

  it('never downloads YouTube audio in the Lite tier', async () => {
    const { resolver, youtube } = setup()
    await expect(
      resolver.resolve(testTrack('a'), request({ ctx: testContext('lite') })),
    ).rejects.toMatchObject({ code: 'Unsupported' })
    expect(youtube.calls).toHaveLength(0)
  })

  it("falls back to itag 18 when the top rung's URLs are capped", async () => {
    // The YouTube ladder (1.4) falls through to itag 18 by itself...
    const ladder = setup()
    ladder.youtube.capped.add('a')
    const fell = await ladder.resolver.resolve(testTrack('a'), request())
    expect(fell.stream).toMatchObject({ url: 'https://media.test/a/18?n=1', media: 'muxed-video' })
    expect(ladder.youtube.log).toEqual(['a:top'])
    // ...and a source that doesn't is asked for its fallback rung.
    const { resolver, youtube } = setup()
    youtube.capped.add('a')
    youtube.fallThrough = false
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

  it("keeps Internet Archive's original where the browser is only maybe sure of it", async () => {
    // Firefox and Safari: `maybe` for a type without codecs (audio/flac, audio/mpeg), and
    // `probably` for audio/ogg; codecs="vorbis".
    const canPlay = (stream: StreamOption) => (stream.container === 'ogg' ? 'probably' : 'maybe')
    const files = (ref: string): StreamOption[] => {
      const { bitrateKbps: _unknown, ...vorbis } = flacStream(`${ref}.ogg`)
      return [
        flacStream(ref),
        {
          ...flacStream(`${ref}_320kb.mp3`),
          codec: 'mp3',
          container: 'mp3',
          tier: 'high',
          bitrateKbps: 320,
        },
        // The Archive's derivative, of a bitrate nobody states.
        { ...vorbis, codec: 'vorbis', container: 'ogg', tier: 'normal' },
      ]
    }
    const archive = new FakeStreamSource({ id: 'archive', expires: false })
    archive.handler = async (candidate) => files(candidate.ref)
    const { resolver } = setup({ sources: [archive], canPlay })
    const track = testTrack('hit.flac', {
      id: formatId('archive', 'track', 'item/hit.flac'),
      source: 'archive',
    })
    expect((await resolver.resolve(track, request())).stream).toMatchObject({ codec: 'flac' })
    // Without a lossless file, the 320 kbps MP3, not the Vorbis derivative.
    archive.handler = async (candidate) => files(candidate.ref).slice(1)
    expect((await resolver.resolve(track, request())).stream).toMatchObject({
      codec: 'mp3',
      bitrateKbps: 320,
    })
  })

  it('downloads the stream the browser is surest of among those of the best quality', async () => {
    // Opus 251 and AAC 140 are both high quality: a browser unsure of Opus gets AAC.
    const { resolver } = setup({
      canPlay: (stream) => (stream.codec === 'opus' ? 'maybe' : 'probably'),
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
    const key = { sourceTrackId: track.id, mode: 'music', target: 'song' } as const
    expect(await matches.get(key)).toMatchObject({ band: 'auto', userPinned: false })
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
      { sourceTrackId: track.id, mode: 'music', target: 'song' },
      {
        band: 'suggest',
        candidate: testCandidate('pin'),
        alternatives: [],
        evidence: [],
        userPinned: true,
        decidedAt: 0,
      },
    )
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('pin')
    expect(matcher.calls).toHaveLength(0)
  })

  it('matches again when a stored match is stale', async () => {
    const { resolver, matcher, matches } = setup()
    const track = testSpotifyTrack('hit')
    await matches.put(
      { sourceTrackId: track.id, mode: 'music', target: 'song' },
      {
        band: 'auto',
        candidate: testCandidate('old'),
        alternatives: [],
        evidence: [],
        userPinned: false,
        decidedAt: 0,
      },
    )
    matcher.rank(track, 'song', [{ candidate: testCandidate('new'), band: 'auto' }])
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('new')
  })

  it('keeps a decision that nothing came close for a day, as playback does', async () => {
    let now = Date.UTC(2026, 9, 26)
    const { resolver, matcher, matches } = setup({ now: () => now })
    const track = testSpotifyTrack('hit')
    const key = { sourceTrackId: track.id, mode: 'music', target: 'song' } as const
    const error = await resolver.resolve(track, request()).catch((caught) => caught)
    expect(playbackProblemOf(error)).toMatchObject({ type: 'unavailable', reason: 'no-match' })
    expect(await matches.get(key)).toMatchObject({ band: 'none', userPinned: false })
    // Within the day the engine isn't asked again.
    await resolver.resolve(track, request()).catch(() => {})
    expect(matcher.calls).toHaveLength(1)
    // After it, the track is matched again.
    now += 24 * 60 * 60_000 + 1
    matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('m')
    expect(matcher.calls).toHaveLength(2)
  })

  it('never stores an outcome some pages were missing from', async () => {
    const { resolver, matcher, matches } = setup()
    const track = testSpotifyTrack('hit')
    matcher.rank(track, 'song', [{ candidate: testCandidate('m'), band: 'auto' }])
    const match = matcher.match.bind(matcher)
    matcher.match = async (...args) => ({ ...(await match(...args)), incomplete: true })
    expect((await resolver.resolve(track, request())).candidate.ref).toBe('m')
    expect(matches.size).toBe(0)
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
