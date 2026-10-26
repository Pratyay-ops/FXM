// @vitest-environment happy-dom
import {
  FxmError,
  formatId,
  type PlaybackProblem,
  playbackProblemError,
  type UnavailableReason,
} from '@fxm/core'
import { classifyFailure, Player, type PlayerOptions, StreamLifecycle } from '@fxm/player'
import {
  FAKE_URL_LIFETIME_MS,
  FakeStreamSource,
  ladderStreams,
  testCandidate,
  testContext,
  testTracks,
} from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopAudioEngine } from './engine'
import { DESKTOP_PLAYER_OPTIONS, desktopClassifyFailure } from './options'

const TRACK = formatId('ytm', 'track', 'a')

function unavailable(reason: UnavailableReason): FxmError {
  return playbackProblemError({ type: 'unavailable', trackId: TRACK, reason, alternatives: [] })
}

describe('desktopClassifyFailure', () => {
  it('retries a song whose sources offered nothing the engine may play', () => {
    expect(desktopClassifyFailure(unavailable('no-stream'))).toBe('retry')
    // The player's own classes skip it.
    expect(classifyFailure(unavailable('no-stream'))).toBe('skip')
  })

  it('leaves every other failure to the player’s classes', () => {
    for (const reason of ['no-match', 'unplayable', 'pinned-unplayable', 'no-source'] as const) {
      expect(desktopClassifyFailure(unavailable(reason)), reason).toBe('skip')
    }
    const review: PlaybackProblem = {
      type: 'needs-review',
      trackId: TRACK,
      guess: testCandidate('guess'),
      alternatives: [],
    }
    expect(desktopClassifyFailure(playbackProblemError(review))).toBe('skip')
    expect(desktopClassifyFailure(new FxmError('Unavailable', 'gone'))).toBe('skip')
    expect(desktopClassifyFailure(new FxmError('BotCheck', 'prove it'))).toBe('stop')
    expect(desktopClassifyFailure(new FxmError('Network', 'offline'))).toBe('retry')
    expect(desktopClassifyFailure(new Error('anything'))).toBe('retry')
  })

  it('is the desktop player’s classifier', () => {
    expect(DESKTOP_PLAYER_OPTIONS.classifyFailure).toBe(desktopClassifyFailure)
  })
})

describe('a song whose end-of-file probe got no answer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 26) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A YouTube ladder whose end-of-file probe answers only from its `answersFrom`-th resolution
   * on: the ones before return the URLs `unverified`, as when the probe timed out.
   */
  function flakyProbe(answersFrom: number) {
    const source = new FakeStreamSource({ now: () => Date.now() })
    source.handler = async (candidate, request) =>
      ladderStreams(candidate.ref, {
        rung: request.rung,
        fullLength: source.calls.length >= answersFrom ? 'verified' : 'unverified',
        serial: source.calls.length,
        expiresAt: Date.now() + FAKE_URL_LIFETIME_MS,
      })
    return source
  }

  /** The desktop app's player, stream lifecycle and engine, on Windows. */
  function setup(source: FakeStreamSource, options: Partial<PlayerOptions>) {
    const lifecycle = new StreamLifecycle({
      sources: [source],
      context: () => testContext('full'),
      now: () => Date.now(),
    })
    const engine = new DesktopAudioEngine({
      createAudio: () => {
        const audio = document.createElement('audio')
        audio.canPlayType = () => 'probably'
        return audio
      },
      environment: () => ({ os: 'windows', tray: true }),
    })
    const load = vi.spyOn(engine, 'load')
    const player = new Player({ ...options, engine, resolver: lifecycle })
    lifecycle.attach(player)
    const failed = vi.fn()
    player.on('trackfailed', ({ error }) => failed(error))
    return { player, load, failed }
  }

  it('plays on the retry, which resolves it afresh and probes again', async () => {
    // The first resolution of each rung comes back unprobed, the third (the top again) probed.
    const source = flakyProbe(3)
    const { player, load, failed } = setup(source, DESKTOP_PLAYER_OPTIONS)
    await player.setQueue(testTracks('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.log).toEqual(['a:top', 'a:fallback', 'a:top'])
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.calls[0]?.[0].stream).toMatchObject({ fullLength: 'verified', codec: 'opus' })
    expect(failed).not.toHaveBeenCalled()
    player.destroy()
  })

  it('would be skipped as unavailable with the player’s own classes', async () => {
    const source = flakyProbe(3)
    const { player, load, failed } = setup(source, {})
    await player.setQueue(testTracks('a'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(source.log).toEqual(['a:top', 'a:fallback'])
    expect(load).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
    player.destroy()
  })

  it('gives up after the player’s retries when no probe ever answers', async () => {
    const source = flakyProbe(Number.POSITIVE_INFINITY)
    const { player, load, failed } = setup(source, DESKTOP_PLAYER_OPTIONS)
    await player.setQueue(testTracks('a'))
    // The player waits 0, 1 and 3 s before its three retries.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
    expect(failed.mock.calls[0]?.[0]).toBeInstanceOf(FxmError)
    expect(player.getState()).toMatchObject({ status: 'error' })
    // Each retry resolves the top rung afresh, so each probes again; nothing else repeats.
    expect(source.log.filter((call) => call === 'a:top')).toHaveLength(4)
    expect(source.log.filter((call) => call === 'a:fallback')).toHaveLength(1)
    player.destroy()
  })
})
