import { playbackProblemOf } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTrack } from '../testing/fixtures'
import { ladderUrl, settle, setup, useFakeClock } from './test-harness'
import { testCandidate, testSpotifyTrack } from './testing/fixtures'

beforeEach(useFakeClock)

afterEach(() => {
  vi.useRealTimers()
})

const guessed = testSpotifyTrack('S')
const guess = testCandidate('guess')
const other = testCandidate('other')
const a = testTrack('a')
const c = testTrack('c')

/** A setup in which the Spotify track's best match is a Suggest-band guess. */
function setupGuess(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup(options)
  harness.matcher.rank(guessed, 'song', [
    { candidate: guess, band: 'suggest' },
    { candidate: other, band: 'suggest' },
  ])
  return harness
}

describe('queues skip Suggest-band guesses and mark them "needs review"', () => {
  it('skips a guess the queue reaches by itself', async () => {
    const { player, engine, youtube, failed, current } = setupGuess()
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(current()).toBe('c')
    expect(youtube.callsFor('guess')).toBe(0)
    expect(engine.loadedUrls).toEqual([ladderUrl('a', 251, 1), ladderUrl('c', 251, 2)])
    expect(playbackProblemOf(failed[0])).toEqual({
      type: 'needs-review',
      trackId: guessed.id,
      guess,
      alternatives: [other],
    })
  })

  it('lists the guess for review and announces the change', async () => {
    const { lifecycle, player, engine, events } = setupGuess()
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(lifecycle.reviews()).toEqual([{ track: guessed, guess, alternatives: [other] }])
    expect(events.reviews).toEqual([[{ track: guessed, guess, alternatives: [other] }]])
  })

  it('skips a guess that "next" lands on', async () => {
    const { player, engine, current } = setupGuess()
    await player.setQueue([a, guessed, c])
    await player.next()
    await settle()
    expect(current()).toBe('c')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('c', 251, 2))
  })

  it('marks a guess before the queue reaches it, while prefetching', async () => {
    const { lifecycle, player, engine, youtube } = setupGuess()
    await player.setQueue([a, guessed, c])
    engine.emit('durationchange', 180_000)
    engine.progress(150_000)
    await settle()
    expect(lifecycle.reviews().map((review) => review.track)).toEqual([guessed])
    expect(youtube.log).toEqual(['a:top', 'c:top'])
    engine.end()
    await settle()
    // The prefetched URL plays.
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('c', 251, 2))
    expect(youtube.log).toEqual(['a:top', 'c:top'])
  })

  it('never records a guess on the queue item, so it never plays by itself later', async () => {
    const { player, engine, youtube, current, recorded } = setupGuess()
    player.setRepeat('all')
    await player.setQueue([guessed, c])
    expect(recorded()).toBeUndefined()
    engine.end()
    await settle()
    expect(current()).toBe('c')
    engine.end()
    await settle()
    // Round again: the guess comes up by itself and is skipped.
    expect(current()).toBe('c')
    expect(youtube.callsFor('guess')).toBe(1)
  })
})

describe('a Suggest-band guess plays after an explicit user action', () => {
  it('plays when the user taps it', async () => {
    const { player, engine, recorded } = setupGuess()
    await player.setQueue([a, guessed, c], { startIndex: 1 })
    expect(engine.loadedUrls).toEqual([ladderUrl('guess', 251, 1)])
    expect(recorded()).toBeUndefined()
    expect(player.getState().status).toBe('playing')
  })

  it('plays when the user jumps to it', async () => {
    const { player, engine, current } = setupGuess()
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(current()).toBe('c')
    await player.play(1)
    expect(current()).toBe('S')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('guess', 251, 3))
  })

  it('plays when the user goes back to it', async () => {
    const { player, engine, current } = setupGuess()
    await player.setQueue([a, guessed, c])
    await player.next()
    await settle()
    expect(current()).toBe('c')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('c', 251, 2))
    await player.previous()
    expect(current()).toBe('S')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('guess', 251, 3))
  })

  it('plays when the user presses play on the guess the queue stopped at', async () => {
    const { player, engine, current } = setupGuess()
    await player.setQueue([a, guessed])
    engine.end()
    await settle()
    expect(player.getState()).toMatchObject({ status: 'error', error: { reason: 'track-failed' } })
    expect(current()).toBe('S')
    await player.play()
    expect(player.getState().status).toBe('playing')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('guess', 251, 2))
  })

  it('keeps playing the guess the user asked for through a retry', async () => {
    const { player, engine, youtube } = setupGuess()
    await player.setQueue([guessed])
    engine.progress(30_000)
    engine.fail('network')
    await settle()
    expect(youtube.log).toEqual(['guess:top', 'guess:top'])
    expect(engine.loadStarts).toEqual([0, 30_000])
  })

  it('still lists a guess the user played for review, until they confirm it', async () => {
    const { lifecycle, player } = setupGuess()
    await player.setQueue([guessed])
    expect(lifecycle.reviews().map((review) => review.guess)).toEqual([guess])
    await lifecycle.confirmMatch(guessed, guess)
    expect(lifecycle.reviews()).toEqual([])
  })
})

describe('guesses that play without asking', () => {
  it('plays guesses unattended with "Play best guesses" on', async () => {
    const { player, engine, current, recorded } = setupGuess({
      settings: { playBestGuesses: true },
    })
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(current()).toBe('S')
    expect(engine.loadedUrls.at(-1)).toBe(ladderUrl('guess', 251, 2))
    expect(recorded()).toBeUndefined()
  })

  it('plays a confirmed guess unattended, as the item’s audio', async () => {
    const { lifecycle, player, engine, current, recorded } = setupGuess()
    await lifecycle.confirmMatch(guessed, guess)
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(current()).toBe('S')
    expect(recorded()).toEqual(guess)
  })

  it('plays an Auto-band match unattended', async () => {
    const { player, engine, matcher, current, recorded } = setup()
    matcher.rank(guessed, 'song', [{ candidate: guess, band: 'auto' }])
    await player.setQueue([a, guessed, c])
    engine.end()
    await settle()
    expect(current()).toBe('S')
    expect(recorded()).toEqual(guess)
  })

  it('never treats a preload of the next item as the user asking for it', async () => {
    const { player, engine, youtube } = setupGuess()
    await player.setQueue([a, guessed])
    engine.emit('durationchange', 180_000)
    engine.progress(150_000)
    await settle()
    expect(youtube.callsFor('guess')).toBe(0)
  })
})
