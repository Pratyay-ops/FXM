import { testTracks } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { setupTestPlayback, spotifyTrack, testCandidate } from '../now-playing/testing'
import { approveAllBestGuesses, chooseVersion, playBestGuess, sameAudio } from './review-actions'
import { useQueueReviewStore } from './review-store'

const titles = (items: readonly { track: { title: string } }[]) =>
  items.map((item) => item.track.title)

describe('choosing a version', () => {
  it('gives every queue item of the track the version, pins it and ends its review', async () => {
    const { player, policy } = setupTestPlayback()
    const track = spotifyTrack('A')
    await player.setQueue([track, ...testTracks('b'), track], { autoplay: false })
    policy.reportNeedsReview(track, testCandidate('guess'))
    const picked = testCandidate('picked')

    chooseVersion(track, picked)

    const items = player.getState().queue.items
    expect(items[0]?.candidate).toBe(picked)
    expect(items[1]?.candidate).toBeUndefined()
    expect(items[2]?.candidate).toBe(picked)
    expect(policy.pins).toEqual([{ track, candidate: picked }])
    expect(useQueueReviewStore.getState().entries).toEqual({})
  })

  it('switches the playing track at once, at the same position', async () => {
    const { player, resolver, engine } = setupTestPlayback()
    const track = spotifyTrack('A')
    await player.setQueue([track])
    engine.progress(30_000)

    chooseVersion(track, testCandidate('other'))

    await expect.poll(() => resolver.log).toEqual(['A:play#0', 'A:replace#0'])
    expect(engine.loadStarts.at(-1)).toBe(30_000)
  })

  it('doesn’t interrupt a track that already plays the chosen version', async () => {
    const { player, resolver } = setupTestPlayback()
    const track = spotifyTrack('A')
    const guess = testCandidate('guess')
    await player.setQueue([track])
    player.setCandidate(player.getState().queue.items[0]?.uid ?? -1, guess)
    await expect.poll(() => resolver.log.length).toBe(2)

    // The same audio, read back from storage: an equal object, not the same one.
    chooseVersion(track, { ...guess })

    expect(resolver.log).toEqual(['A:play#0', 'A:replace#0'])
  })

  it('compares versions by source and ID', () => {
    expect(sameAudio(testCandidate('a'), testCandidate('a', { confidence: 0.5 }))).toBe(true)
    expect(sameAudio(testCandidate('a'), testCandidate('b'))).toBe(false)
    expect(sameAudio(testCandidate('a'), { ...testCandidate('a'), source: 'archive' })).toBe(false)
    expect(sameAudio(undefined, testCandidate('a'))).toBe(false)
  })
})

describe('approving every best guess', () => {
  it('approves them all, and moves the ones the queue skipped to play next', async () => {
    const { player, policy } = setupTestPlayback()
    const [s1, s2, ahead] = [spotifyTrack('S1'), spotifyTrack('S2'), spotifyTrack('Ahead')]
    const [a, b, c] = testTracks('a', 'b', 'c')
    if (a === undefined || b === undefined || c === undefined) throw new Error('no tracks')
    // Played: s1, a, s2; current: b; up next: ahead, c.
    await player.setQueue([s1, a, s2, b, ahead, c], { startIndex: 3, autoplay: false })
    for (const track of [s1, s2, ahead]) policy.reportNeedsReview(track, testCandidate(track.title))

    approveAllBestGuesses()

    const { items, index } = player.getState().queue
    expect(titles(items)).toEqual(['a', 'b', 'S1', 'S2', 'Ahead', 'c'])
    expect(items[index]?.track.title).toBe('b')
    expect(
      items.filter((item) => item.candidate !== undefined).map((item) => item.candidate?.ref),
    ).toEqual(['S1', 'S2', 'Ahead'])
    expect(policy.pins.map((pin) => pin.track.title)).toEqual(['S1', 'S2', 'Ahead'])
    expect(useQueueReviewStore.getState().entries).toEqual({})
  })

  it('does nothing when nothing needs review', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    const before = player.getState().queue
    approveAllBestGuesses()
    expect(player.getState().queue).toBe(before)
  })
})

describe('playing a best guess', () => {
  it('plays the item with its best guess, and keeps it on the review list', async () => {
    const { player, policy, resolver } = setupTestPlayback()
    const track = spotifyTrack('A')
    await player.setQueue([...testTracks('x'), track], { autoplay: false })
    const guess = testCandidate('guess')
    policy.reportNeedsReview(track, guess)
    const item = player.getState().queue.items[1]
    if (item === undefined) throw new Error('no item')

    playBestGuess(item, 1, guess)

    await expect.poll(() => resolver.requests.length).toBe(1)
    expect(resolver.requests[0]?.item.candidate).toBe(guess)
    expect(player.getState().queue.index).toBe(1)
    expect(useQueueReviewStore.getState().entries[track.id]).toBe(guess)
  })
})
