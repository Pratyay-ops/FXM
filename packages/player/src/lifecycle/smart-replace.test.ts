import {
  type AudioCandidate,
  currentQueueItem,
  FxmError,
  formatId,
  type MatchTarget,
  playbackProblemOf,
  type Track,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError } from '../engine'
import type { Player } from '../player'
import { testTrack } from '../testing/fixtures'
import type { MemoryMatchStore } from './adapters'
import { ladderUrl, settle, setup, useFakeClock } from './test-harness'
import { FAKE_URL_LIFETIME_MS, ladderStreams } from './testing/fake-stream-source'
import { testCandidate, testSpotifyTrack } from './testing/fixtures'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

const spotify = testSpotifyTrack('S')
const x = testCandidate('x')
const y = testCandidate('y')

function stored(matches: MemoryMatchStore, track: Track, target: MatchTarget = 'song') {
  return matches.get({ sourceTrackId: track.id, mode: 'music', target })
}

/** The uid of the current queue item. */
function currentUid(player: Player): number {
  const item = currentQueueItem(player.getState().queue)
  if (item === undefined) throw new Error('no current item')
  return item.uid
}

/** The refs each matcher call excluded. */
function exclusions(calls: { request: { exclude: readonly AudioCandidate[] } }[]): string[][] {
  return calls.map(({ request }) => request.exclude.map((candidate) => candidate.ref))
}

/** A setup in which the Spotify track's best match is `x`, then `y`, both in the Auto band. */
function setupMatched(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup(options)
  harness.matcher.rank(spotify, 'song', [
    { candidate: x, band: 'auto' },
    { candidate: y, band: 'auto' },
  ])
  return harness
}

describe('Smart Replace: it fires on a playability verdict while other videos resolve', () => {
  it('replaces a match whose video is UNPLAYABLE', async () => {
    const { player, engine, youtube, matcher, matches, events, recorded } = setupMatched()
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(exclusions(matcher.calls)).toEqual([[], ['x']])
    expect(youtube.log).toEqual(['a:top', 'x:top', 'y:top'])
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('y', 251, 3))
    expect(recorded()).toEqual(y)
    expect(await stored(matches, spotify)).toMatchObject({
      candidate: y,
      band: 'auto',
      userPinned: false,
    })
    expect(events.replaced).toEqual([{ track: spotify, from: x, to: y }])
  })

  it('replaces a match whose video is gone (ERROR)', async () => {
    const { player, youtube, recorded } = setupMatched()
    youtube.verdicts.set('x', 'ERROR')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(recorded()).toEqual(y)
  })

  it('replaces the match recorded on the queue item when its video goes away later', async () => {
    const { player, engine, youtube, matcher, events, recorded } = setupMatched()
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(recorded()).toEqual(x)
    engine.progress(42_000)
    youtube.verdicts.set('x', 'UNPLAYABLE')
    engine.fail('network')
    await settle()
    expect(exclusions(matcher.calls)).toEqual([[], ['x']])
    expect(recorded()).toEqual(y)
    expect(engine.loadStarts.at(-1)).toBe(42_000)
    expect(events.replaced).toEqual([{ track: spotify, from: x, to: y }])
  })

  it('resolves the next track afresh when its cached URL is the only proof, after a pause', async () => {
    const { lifecycle, player, youtube, matcher, recorded } = setupMatched()
    const c = testTrack('c')
    await player.setQueue([testTrack('a'), spotify, c])
    const upcoming = player.getState().queue.items[2]
    if (upcoming === undefined) throw new Error('short queue')
    lifecycle.prefetch([upcoming])
    await settle()
    // Half an hour later, c's URL is still cached, but it no longer proves anything.
    player.pause()
    await settle(31 * 60_000)
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.play(1)
    expect(youtube.log).toEqual(['a:top', 'c:top', 'x:top', 'c:top', 'y:top'])
    expect(exclusions(matcher.calls)).toEqual([[], ['x']])
    expect(recorded()).toEqual(y)
    // The fresh resolution of c is cached for when it plays.
    await player.next()
    expect(youtube.callsFor('c')).toBe(2)
  })

  it('checks that other videos still resolve by resolving the next track', async () => {
    const { player, youtube, recorded } = setupMatched()
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([spotify, testTrack('a')])
    expect(youtube.log).toEqual(['x:top', 'a:top', 'y:top'])
    expect(youtube.calls[1]?.request.priority).toBe('prefetch')
    expect(recorded()).toEqual(y)
  })

  it('replaces a music video’s linked song that is gone with its matched song', async () => {
    const video = testTrack('v', { kind: 'music-video', songId: formatId('ytm', 'track', 'dead') })
    const { player, youtube, matcher, recorded } = setup()
    matcher.rank(video, 'song', [{ candidate: y, band: 'auto' }])
    youtube.verdicts.set('dead', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), video])
    await player.next()
    expect(youtube.log).toEqual(['a:top', 'dead:top', 'y:top'])
    expect(exclusions(matcher.calls)).toEqual([['dead']])
    expect(recorded()).toEqual(y)
  })

  it('reports the track unavailable when nothing replaces the match, and stores that', async () => {
    const { player, youtube, matcher, matches, failed } = setup()
    matcher.rank(spotify, 'song', [{ candidate: x, band: 'auto' }])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({
      type: 'unavailable',
      reason: 'unplayable',
      code: 'Unavailable',
      detail: 'ytm item x is UNPLAYABLE',
    })
    const decision = await stored(matches, spotify)
    expect(decision).toMatchObject({ band: 'none', userPinned: false })
    expect(decision).not.toHaveProperty('candidate')
  })

  it('holds a Suggest-band replacement back for review', async () => {
    const { player, youtube, matcher, failed, lifecycle } = setup()
    matcher.rank(spotify, 'song', [
      { candidate: x, band: 'auto' },
      { candidate: y, band: 'suggest' },
    ])
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ type: 'needs-review', guess: y })
    expect(lifecycle.reviews().map((review) => review.guess)).toEqual([y])
    expect(youtube.callsFor('y')).toBe(0)
  })
})

describe('Smart Replace: matches survive failures that say nothing about them', () => {
  it.each([
    ['a bot check', new FxmError('BotCheck', 'LOGIN_REQUIRED on every rung')],
    ['a network error, e.g. offline', new FxmError('Network', 'offline')],
    ['an expired URL', new FxmError('Expired', 'too late')],
    ['a source refusal without a verdict', new FxmError('Unavailable', 'age-restricted')],
  ])('keeps the match after %s', async (_label, error) => {
    const { player, youtube, matcher, matches, events } = setupMatched()
    youtube.errors.set('x', error)
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    await vi.runAllTimersAsync()
    expect(matcher.calls).toHaveLength(1)
    expect(await stored(matches, spotify)).toMatchObject({ candidate: x })
    expect(events.replaced).toEqual([])
  })

  it('keeps the match when every rung of the ladder is capped', async () => {
    const { player, youtube, matcher, matches, failed } = setupMatched()
    youtube.handler = async (candidate, request) =>
      ladderStreams(candidate.ref, {
        rung: request.rung,
        fullLength: candidate.ref === 'x' ? 'capped' : 'verified',
        serial: youtube.calls.length,
        expiresAt: Date.now() + FAKE_URL_LIFETIME_MS,
      })
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(youtube.log).toEqual(['a:top', 'x:top', 'x:fallback'])
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'no-stream' })
    expect(matcher.calls).toHaveLength(1)
    expect(await stored(matches, spotify)).toMatchObject({ candidate: x })
  })

  it('keeps the match after a 403 from an IP change', async () => {
    const { player, engine, youtube, matcher, events, recorded } = setupMatched()
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    await player.previous()
    await player.next()
    // A cached URL answers 403: the device's IP address probably changed.
    engine.progress(10_000)
    engine.emit('error', new EngineError('network', 'HTTP 403', { cause: { status: 403 } }))
    await settle()
    expect(events.flushes.map((flush) => flush.reason)).toEqual(['ip-changed'])
    expect(youtube.log).toEqual(['a:top', 'x:top', 'x:top'])
    expect(matcher.calls).toHaveLength(1)
    expect(recorded()).toEqual(x)
  })

  it('keeps the match when no other video resolves, since the IP may be flagged', async () => {
    const { player, youtube, matcher, matches, failed } = setupMatched()
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([spotify])
    expect(matcher.calls).toHaveLength(1)
    expect(await stored(matches, spotify)).toMatchObject({ candidate: x })
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'unplayable' })
  })

  it('keeps the match when the only proof that videos resolve is older than its window', async () => {
    const { player, youtube, matcher } = setupMatched()
    await player.setQueue([testTrack('a'), spotify])
    await settle(31 * 60_000)
    youtube.verdicts.set('x', 'UNPLAYABLE')
    youtube.verdicts.set('a', 'UNPLAYABLE')
    await player.next()
    expect(matcher.calls).toHaveLength(1)
  })

  it('never re-matches the track’s own video', async () => {
    const { player, youtube, matcher, failed } = setup()
    youtube.verdicts.set('b', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), testTrack('b')])
    await player.next()
    expect(matcher.calls).toHaveLength(0)
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'unplayable' })
  })
})

describe('Smart Replace: pins are protected', () => {
  it('never replaces or deletes a pin whose video is gone', async () => {
    const { lifecycle, player, youtube, matcher, matches, failed, events } = setupMatched()
    await lifecycle.pinMatch(spotify, x)
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(matcher.calls).toHaveLength(0)
    expect(await stored(matches, spotify)).toMatchObject({ candidate: x, userPinned: true })
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'pinned-unplayable' })
    expect(events.replaced).toEqual([])
  })

  it('pins a version only when the user asks: pinMatch, not a version pick', async () => {
    const { lifecycle, player, matches, youtube, recorded } = setupMatched()
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    player.setCandidate(currentUid(player), y)
    await settle()
    // The pick plays on this item, and the match cache still holds the engine's decision.
    expect(recorded()).toEqual(y)
    expect(youtube.log.at(-1)).toBe('y:top')
    expect(await stored(matches, spotify)).toMatchObject({ candidate: x, userPinned: false })
    await lifecycle.pinMatch(spotify, y)
    expect(await stored(matches, spotify)).toMatchObject({
      candidate: y,
      alternatives: [x],
      evidence: ['pinned by the user'],
      userPinned: true,
    })
  })

  it('never swaps the version the user just picked, even when its video is gone', async () => {
    const { player, youtube, matcher, failed, events } = setupMatched()
    const z = testCandidate('z')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    youtube.verdicts.set('z', 'UNPLAYABLE')
    player.setCandidate(currentUid(player), z)
    await settle()
    expect(matcher.calls).toHaveLength(1)
    expect(youtube.callsFor('x')).toBe(1)
    expect(playbackProblemOf(failed.at(-1))).toMatchObject({ reason: 'pinned-unplayable' })
    expect(events.replaced).toEqual([])
  })

  it('plays a pin first, before the recorded candidate and the matching engine', async () => {
    const { lifecycle, player, matcher, recorded } = setupMatched()
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(recorded()).toEqual(x)
    await lifecycle.pinMatch(spotify, y)
    await player.previous()
    await player.next()
    expect(recorded()).toEqual(y)
    expect(matcher.calls).toHaveLength(1)
  })

  it('lets the user pin a version that Smart Replace gave up on', async () => {
    const { lifecycle, player, youtube, recorded } = setupMatched()
    youtube.verdicts.set('x', 'UNPLAYABLE')
    await player.setQueue([testTrack('a'), spotify])
    await player.next()
    expect(recorded()).toEqual(y)
    youtube.verdicts.delete('x')
    await lifecycle.pinMatch(spotify, x)
    await player.previous()
    await player.next()
    expect(recorded()).toEqual(x)
  })
})
