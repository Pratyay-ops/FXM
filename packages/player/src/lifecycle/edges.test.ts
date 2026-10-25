import {
  type AudioCandidate,
  type AudioSource,
  createQueue,
  currentQueueItem,
  FxmError,
  formatId,
  isFxmError,
  ownCandidate,
  playbackProblemOf,
  type QueueItem,
  type StreamOption,
  setQueue,
  type Track,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player } from '../player'
import { testStream, testTrack } from '../testing/fixtures'
import {
  createMemoryMatchStore,
  fromAudioSource,
  type MatchKey,
  type MatchStore,
  type TrackMatcher,
} from './adapters'
import { StreamLifecycle } from './stream-lifecycle'
import { ladderUrl, playRequest, settle, setup, useFakeClock } from './test-harness'
import { FAKE_URL_LIFETIME_MS, FakeStreamSource, ladderStreams } from './testing/fake-stream-source'
import { testCandidate, testContext, testSpotifyTrack } from './testing/fixtures'

beforeEach(() => {
  useFakeClock()
  // A lifecycle without a player warns once; the tests that call it directly need no player.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const spotify = testSpotifyTrack('S')
const x = testCandidate('x')
const y = testCandidate('y')
const songKey: MatchKey = { sourceTrackId: spotify.id, mode: 'music', target: 'song' }

function itemOf(track: Track): QueueItem {
  const found = currentQueueItem(setQueue(createQueue({ mode: 'all' }), [track]))
  if (found === undefined) throw new Error('empty queue')
  return found
}

/** The track's own audio, which every test track here has. */
function ownOf(track: Track): AudioCandidate {
  const own = ownCandidate(track)
  if (own === undefined) throw new Error('no own audio')
  return own
}

/** The uid of the current queue item. */
function currentUid(player: Player): number {
  const item = currentQueueItem(player.getState().queue)
  if (item === undefined) throw new Error('no current item')
  return item.uid
}

describe('the ladder, beyond the main paths', () => {
  it('goes back to the top when the remembered fallback stops working', async () => {
    const { player, youtube } = setup({ tier: 'full' })
    youtube.fallThrough = false
    youtube.capped.add('a')
    await player.setQueue([testTrack('a'), testTrack('b')])
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
    // Later, itag 18 is capped as well, while VISIONOS serves the video in full again.
    youtube.capped.delete('a')
    const answer = youtube.handler
    youtube.handler = async (candidate, request) =>
      request.rung === 'fallback'
        ? ladderStreams(candidate.ref, {
            rung: 'fallback',
            fullLength: 'capped',
            serial: youtube.calls.length,
          })
        : answer(candidate, request)
    await settle(FAKE_URL_LIFETIME_MS)
    await player.next()
    await player.previous()
    expect(youtube.log).toEqual(['a:top', 'a:fallback', 'b:top', 'a:fallback', 'a:top'])
    expect(player.getState().stream?.media).toBe('audio')
  })

  it('prefetches with a guess of what the player can play before it ever asked', async () => {
    const youtube = new FakeStreamSource()
    youtube.fallThrough = false
    youtube.capped.add('a')
    const lifecycle = new StreamLifecycle({ sources: [youtube], context: () => testContext() })
    lifecycle.prefetch([itemOf(testTrack('a'))])
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:fallback'])
  })

  it('reads no status from a source that cannot tell, or whose check fails', async () => {
    const archive: AudioSource = {
      id: 'archive',
      match: async () => [],
      resolve: async () => [
        testStream('flac', { codec: 'flac', container: 'flac', tier: 'lossless' }),
      ],
    }
    const local: Track = {
      ...testTrack('t'),
      id: formatId('archive', 'track', 'i/t'),
      source: 'archive',
    }
    const { player, engine, youtube } = setup({ sources: [fromAudioSource(archive)] })
    await player.setQueue([local, testTrack('a')])
    engine.progress(1000)
    engine.fail('network')
    await settle()
    expect(engine.loadedUrls).toEqual(['https://media.test/flac', 'https://media.test/flac'])
    await player.next()
    youtube.checkStatus = async () => {
      throw new Error('probe failed')
    }
    engine.fail('unsupported')
    await settle()
    expect(youtube.log).toEqual(['a:top', 'a:top'])
  })

  it('drops a resolution the player no longer needs', async () => {
    const { player, engine, youtube } = setup()
    const pending: (() => void)[] = []
    const answer = youtube.handler
    youtube.handler = (candidate, request) =>
      candidate.ref === 'a'
        ? new Promise<StreamOption[]>((resolve) =>
            pending.push(() => resolve(youtube.answer(candidate, request))),
          )
        : answer(candidate, request)
    const starting = player.setQueue([testTrack('a'), testTrack('b')])
    await settle()
    await player.next()
    for (const release of pending) release()
    await starting
    expect(engine.loadedUrls).toEqual([ladderUrl('b', 251, 2)])
    expect(player.getState().status).toBe('playing')
  })
})

describe('matching, beyond the main paths', () => {
  it('stops the player when the matching engine meets a bot check', async () => {
    const { player, matcher, failed } = setup()
    matcher.fail(spotify, 'song', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    await player.setQueue([spotify])
    expect(isFxmError(failed[0], 'BotCheck')).toBe(true)
    expect(player.getState().error?.reason).toBe('action-required')
  })

  it('retries when the matching engine fails for a while', async () => {
    const { player, matcher, recorded } = setup()
    matcher.fail(spotify, 'song', new FxmError('Network', 'timeout'))
    await player.setQueue([spotify])
    expect(player.getState().status).toBe('loading')
    matcher.fail(spotify, 'song', undefined as unknown as Error)
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await settle()
    expect(recorded()).toEqual(x)
  })

  it('matches a track again once its stored match is too old', async () => {
    const { player, matcher } = setup({ lifecycle: { maxMatchAgeMs: 60_000 } })
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await player.setQueue([spotify])
    await player.setQueue([spotify])
    expect(matcher.calls).toHaveLength(1)
    await settle(60_001)
    await player.setQueue([spotify])
    expect(matcher.calls).toHaveLength(2)
  })

  it('gives up after two replacements in one go', async () => {
    const { player, youtube, matcher, failed } = setup()
    const candidates = ['x', 'y', 'z', 'w'].map((ref) => testCandidate(ref))
    matcher.rank(
      spotify,
      'song',
      candidates.map((candidate) => ({ candidate, band: 'auto' as const })),
    )
    for (const { ref } of candidates) youtube.verdicts.set(ref, 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(youtube.log).toEqual(['a:top', 'x:top', 'y:top', 'z:top'])
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'unplayable' })
  })

  it('tries a candidate once per resolution, even when two steps name it', async () => {
    const { player, engine, youtube, matcher, failed } = setup()
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    youtube.errors.set('x', new FxmError('Unavailable', 'age-restricted'))
    engine.progress(5000)
    engine.fail('network')
    await settle()
    // The recorded candidate and the stored match are the same video: one try.
    expect(youtube.callsFor('x')).toBe(2)
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'unplayable' })
  })

  it('reports a pin that cannot play as the pin’s problem, verdict or not', async () => {
    const { lifecycle, player, youtube, failed } = setup()
    await lifecycle.pinMatch(spotify, x)
    youtube.errors.set('x', new FxmError('Unavailable', 'age-restricted'))
    await player.setQueue([spotify])
    expect(playbackProblemOf(failed[0])).toMatchObject({
      reason: 'pinned-unplayable',
      code: 'Unavailable',
      detail: 'age-restricted',
    })
  })

  it('never matches over a pin, even one whose audio Smart Replace gave up on', async () => {
    const { player, engine, youtube, matcher, matches } = setup({
      settings: { preferLossless: true },
    })
    matcher.rank(spotify, 'song', [
      { candidate: x, band: 'auto' },
      { candidate: y, band: 'auto' },
    ])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    // A pin filed for the lossless copy, e.g. restored from a backup, names the dead video.
    const lossless: MatchKey = { ...songKey, target: 'lossless' }
    await matches.put(lossless, {
      band: 'auto',
      candidate: x,
      alternatives: [],
      evidence: [],
      userPinned: true,
      decidedAt: 0,
    })
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(await matches.get(lossless)).toMatchObject({ candidate: x, userPinned: true })
    expect(matcher.callsFor(spotify, 'lossless')).toBe(1)
    expect(engine.loadedUrls.at(-1)).toContain('/y/')
  })

  it('keeps working when the match store fails', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: MatchStore = {
      get: async () => {
        throw new Error('get')
      },
      put: async () => {
        throw new Error('put')
      },
      delete: async () => {
        throw new Error('delete')
      },
    }
    const { player, matcher, recorded } = setup({ lifecycle: { matches: broken } })
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(recorded()).toEqual(x)
    expect(report.mock.calls.map(([error]) => (error as Error).message)).toContain('put')
  })

  it('keeps going when forgetting a dead match fails', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const memory = createMemoryMatchStore()
    const store: MatchStore = {
      get: (key) => memory.get(key),
      put: (key, match) => memory.put(key, match),
      delete: async () => {
        throw new Error('delete')
      },
    }
    // Matching again without the dead video misses a page, so the outcome is not kept, and the
    // dead match is forgotten instead.
    const matcher: TrackMatcher = {
      match: async (_track, request) =>
        request.exclude.length === 0
          ? { band: 'auto', best: x, alternatives: [] }
          : { band: 'none', alternatives: [], incomplete: true },
    }
    const { player, youtube, failed } = setup({ lifecycle: { matches: store, matcher } })
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'unplayable' })
    expect(report.mock.calls.map(([error]) => (error as Error).message)).toEqual(['delete'])
  })

  it('ignores a malformed stored match', async () => {
    const odd: MatchStore = {
      get: async () => ({ band: 'great' }) as never,
      put: async () => {},
      delete: async () => {},
    }
    const { player, matcher, recorded } = setup({ lifecycle: { matches: odd } })
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await player.setQueue([spotify])
    expect(recorded()).toEqual(x)
  })

  it('needs no pin for a track’s own audio, nor for audio the mode does not play', async () => {
    const { lifecycle, matches } = setup()
    const song = testTrack('a')
    await lifecycle.pinMatch(song, testCandidate('a'))
    await lifecycle.pinMatch(spotify, testCandidate('v', { kind: 'video' }))
    expect(matches.size).toBe(0)
  })

  it('goes back to a song’s own audio when the user picks it after another version', async () => {
    const { player, engine, recorded } = setup()
    const song = testTrack('a')
    await player.setQueue([song])
    const uid = currentUid(player)
    player.setCandidate(uid, testCandidate('alt'))
    await settle()
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('alt', 251, 2))
    player.setCandidate(uid, ownOf(song))
    await settle()
    expect(recorded()).toEqual(ownOf(song))
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 251, 1))
  })

  it('removes another version’s pin when the user pins the song’s own audio', async () => {
    const { lifecycle, player, engine, matches, recorded } = setup()
    const song = testTrack('a')
    await lifecycle.pinMatch(song, testCandidate('alt'))
    await player.setQueue([song])
    expect(engine.loadedUrls).toEqual([ladderUrl('alt', 251, 1)])
    await lifecycle.pinMatch(song, ownOf(song))
    expect(matches.size).toBe(0)
    await player.setQueue([song])
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('a', 251, 2))
    expect(recorded()).toEqual(ownOf(song))
  })

  it('plays the version picked for the item over the track’s pin, also on a retry', async () => {
    const { lifecycle, player, engine, youtube, recorded } = setup()
    const song = testTrack('a')
    await lifecycle.pinMatch(song, testCandidate('alt'))
    await player.setQueue([song])
    player.setCandidate(currentUid(player), ownOf(song))
    await settle()
    expect(recorded()).toEqual(ownOf(song))
    engine.progress(10_000)
    engine.fail('network')
    await settle()
    expect(youtube.log).toEqual(['alt:top', 'a:top', 'a:top'])
    expect(engine.loadStarts.at(-1)).toBe(10_000)
  })

  it('removes a pin when the user asks, so the policy decides again', async () => {
    const { lifecycle, player, matcher, matches, recorded } = setup()
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await lifecycle.pinMatch(spotify, y)
    await player.setQueue([spotify])
    expect(recorded()).toEqual(y)
    await lifecycle.unpinMatch(spotify)
    expect(matches.size).toBe(0)
    await player.setQueue([spotify])
    expect(recorded()).toEqual(x)
    // The engine's decision is no pin, so it stays.
    await lifecycle.unpinMatch(spotify)
    expect(matches.size).toBe(1)
  })

  it('drops malformed alternatives of a stored match and reports the item as it is', async () => {
    const { player, youtube, matcher, matches, failed } = setup()
    const malformed = {
      band: 'auto',
      candidate: x,
      alternatives: [null],
      evidence: [],
      userPinned: false,
      decidedAt: Date.now(),
    }
    await matches.put(songKey, malformed as never)
    youtube.handler = async (candidate, request) =>
      ladderStreams(candidate.ref, {
        rung: request.rung,
        fullLength: 'capped',
        serial: youtube.calls.length,
      })
    await player.setQueue([spotify])
    expect(playbackProblemOf(failed[0])).toEqual({
      type: 'unavailable',
      trackId: spotify.id,
      reason: 'no-stream',
      alternatives: [],
    })
    expect(youtube.log).toEqual(['x:top', 'x:fallback'])
    expect(matcher.calls).toHaveLength(0)
  })

  it('ignores a stored match that the catalog mode does not let play', async () => {
    const { player, engine, matcher, matches, recorded } = setup()
    const video = testCandidate('mv', { kind: 'music-video' })
    await matches.put(songKey, {
      band: 'auto',
      candidate: video,
      alternatives: [video],
      evidence: [],
      userPinned: false,
      decidedAt: Date.now(),
    })
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    await player.setQueue([spotify])
    expect(engine.loadedUrls).toEqual([ladderUrl('x', 251, 1)])
    expect(recorded()).toEqual(x)
  })

  it('plays a candidate named with plain YouTube’s prefix through the ytm source', async () => {
    const { lifecycle, player, engine, youtube } = setup()
    await lifecycle.pinMatch(spotify, testCandidate('v', { source: 'yt' }))
    await player.setQueue([spotify])
    expect(engine.loadedUrls).toEqual([ladderUrl('v', 251, 1)])
    expect(youtube.calls[0]?.candidate.source).toBe('ytm')
  })

  it('replaces the linked song recorded on a music video', async () => {
    const video = testTrack('v', { kind: 'music-video', songId: formatId('ytm', 'track', 'song') })
    const { player, engine, youtube, matcher, recorded } = setup()
    matcher.rank(video, 'song', [{ candidate: y, band: 'auto' }])
    await player.setQueue([testTrack('a'), video])
    await player.next()
    expect(recorded()).toMatchObject({ ref: 'song' })
    youtube.verdicts.set('song', 'UNPLAYABLE')
    engine.progress(5000)
    engine.fail('network')
    await settle()
    expect(recorded()).toEqual(y)
  })

  it('looks past items of other sources for proof that videos resolve', async () => {
    const archive = new FakeStreamSource({ id: 'archive', expires: false })
    const archiveTrack: Track = {
      ...testTrack('t'),
      id: formatId('archive', 'track', 'i/t'),
      source: 'archive',
    }
    const { player, youtube, matcher, recorded } = setup({ sources: [archive] })
    matcher.rank(spotify, 'song', [
      { candidate: x, band: 'auto' },
      { candidate: y, band: 'auto' },
    ])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([spotify, archiveTrack, testTrack('a')])
    expect(archive.calls).toHaveLength(0)
    expect(youtube.log).toEqual(['x:top', 'a:top', 'y:top'])
    expect(recorded()).toEqual(y)
  })

  it('never replaces a match for a player it does not follow, lacking proof', async () => {
    const { lifecycle, youtube, matcher } = setup({ attach: false })
    matcher.rank(spotify, 'song', [
      { candidate: x, band: 'auto' },
      { candidate: y, band: 'auto' },
    ])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    const error = await lifecycle.resolve(itemOf(spotify), playRequest()).catch((e: unknown) => e)
    expect(playbackProblemOf(error)).toMatchObject({ reason: 'unplayable' })
    expect(matcher.calls).toHaveLength(1)
  })
})

describe('Invidious, beyond the main path', () => {
  it('has nothing to resolve without YouTube audio', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    const { player, failed } = setup({
      tier: 'free',
      invidious,
      settings: { useInvidious: true },
    })
    await player.setQueue([spotify])
    expect(invidious.calls).toHaveLength(0)
    expect(isFxmError(failed[0], 'Unsupported')).toBe(true)
  })

  it('plays the track’s own video through Invidious where YouTube is out of reach', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    const { player, engine } = setup({
      tier: 'free',
      invidious,
      settings: { useInvidious: true },
    })
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual(['https://invidious.test/a/251?n=1'])
  })

  it('plays a guess the user asked for through Invidious without recording it', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    const { player, youtube, matcher, recorded } = setup({
      invidious,
      settings: { useInvidious: true },
    })
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'suggest' }])
    youtube.errors.set('x', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    await player.setQueue([spotify])
    expect(invidious.log).toEqual(['x:top'])
    expect(recorded()).toBeUndefined()
  })

  it('gives up when the instance fails or has nothing playable', async () => {
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    const { player, youtube, failed } = setup({ invidious, settings: { useInvidious: true } })
    youtube.errors.set('a', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    youtube.errors.set('b', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    invidious.errors.set('a', new FxmError('Network', 'instance down'))
    invidious.handler = async (candidate, request) =>
      candidate.ref === 'b'
        ? ladderStreams('b', { rung: 'top', fullLength: 'capped', serial: 1 })
        : invidious.answer(candidate, request)
    await player.setQueue([testTrack('a')])
    expect(isFxmError(failed[0], 'BotCheck')).toBe(true)
    await player.setQueue([testTrack('b')])
    expect(isFxmError(failed[1], 'BotCheck')).toBe(true)
  })
})

describe('what the resolver reports', () => {
  it('reports a track the mode hides as having no source', async () => {
    const { lifecycle } = setup()
    const video = testTrack('v', { kind: 'video' })
    const error = await lifecycle.resolve(itemOf(video), playRequest()).catch((e: unknown) => e)
    expect(playbackProblemOf(error)).toMatchObject({ type: 'unavailable', reason: 'no-source' })
  })

  it('skips an offline copy the player cannot play', async () => {
    const offline = { find: async () => testStream('blob', { codec: 'alac', container: 'm4a' }) }
    const { player, engine } = setup({ offline })
    engine.canPlayStream = (stream) => (stream.codec === 'alac' ? 'no' : 'probably')
    await player.setQueue([testTrack('a')])
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1)])
  })
})

describe('giving up on a resolution the player no longer needs', () => {
  /** A promise that rejects with the signal's reason once it aborts. */
  function hang<T>(signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }

  async function abortedWhile(lifecycle: StreamLifecycle, track: Track): Promise<unknown> {
    const abort = new AbortController()
    const resolving = lifecycle.resolve(itemOf(track), playRequest(abort.signal))
    await settle()
    abort.abort(new Error('skipped'))
    return resolving.catch((error: unknown) => error)
  }

  it('while looking for an offline copy', async () => {
    const lifecycle = new StreamLifecycle({
      sources: [new FakeStreamSource()],
      offline: { find: (_track, ctx) => hang(ctx.signal) },
      context: () => testContext(),
    })
    expect(await abortedWhile(lifecycle, testTrack('a'))).toEqual(new Error('skipped'))
  })

  it('while matching', async () => {
    const lifecycle = new StreamLifecycle({
      sources: [new FakeStreamSource()],
      matcher: { match: (_track, request) => hang(request.signal) },
      context: () => testContext(),
    })
    expect(await abortedWhile(lifecycle, spotify)).toEqual(new Error('skipped'))
  })

  it('while asking the Invidious instance', async () => {
    const youtube = new FakeStreamSource()
    youtube.errors.set('a', new FxmError('BotCheck', 'LOGIN_REQUIRED'))
    const invidious = new FakeStreamSource({ host: 'invidious.test' })
    invidious.handler = (_candidate, request) => hang(request.signal)
    const lifecycle = new StreamLifecycle({
      sources: [youtube],
      invidious,
      settings: () => ({ preferLossless: false, playBestGuesses: false, useInvidious: true }),
      context: () => testContext(),
    })
    expect(await abortedWhile(lifecycle, testTrack('a'))).toEqual(new Error('skipped'))
  })

  it('while checking that other videos resolve', async () => {
    const { player, engine, youtube, matcher, failed } = setup()
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    const answer = youtube.handler
    youtube.handler = (candidate, request) =>
      candidate.ref === 'a' ? hang(request.signal) : answer(candidate, request)
    const starting = player.setQueue([spotify, testTrack('a'), testTrack('b')])
    await settle()
    // Jumping elsewhere drops the resolution, and with it the check on the next track.
    await player.play(2)
    await starting
    expect(failed).toEqual([])
    expect(engine.loadedUrls).toEqual([ladderUrl('b', 251, 3)])
  })
})
