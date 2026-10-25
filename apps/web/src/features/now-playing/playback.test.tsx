import { FxmError } from '@fxm/core'
import { testTrack, testTracks } from '@fxm/player/testing'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PLAYBACK_STORAGE_KEY, QUEUE_STORAGE_KEY } from '../queue/queue-storage'
import { useQueueReviewStore } from '../queue/review-store'
import { useSettingsStore } from '../settings/settings-store'
import { getPlayer, usePlayerState } from './playback'
import { createPendingPolicy, PENDING_RESOLVER_MESSAGE } from './playback-policy'
import { setupTestPlayback, spotifyTrack, testCandidate } from './testing'

describe('the app’s playback', () => {
  it('plays through the policy’s resolver', async () => {
    const { player, resolver, engine } = setupTestPlayback()
    expect(getPlayer()).toBe(player)

    await player.setQueue(testTracks('a', 'b'))

    expect(resolver.log).toEqual(['a:play#0'])
    expect(engine.loadedUrls).toEqual(['https://media.test/a'])
    expect(player.getState().status).toBe('playing')
  })

  it('starts in the catalog mode of the settings and follows it', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { player } = setupTestPlayback()
    expect(player.getState().queue.mode).toBe('all')
    const video = testTrack('video', { kind: 'video' })
    await player.setQueue([testTrack('song'), video], { autoplay: false })
    expect(player.getState().queue.items).toHaveLength(2)

    act(() => useSettingsStore.getState().setCatalogMode('music'))

    expect(player.getState().queue.mode).toBe('music')
    expect(player.getState().queue.items.map((item) => item.track.title)).toEqual(['song'])
  })

  it('puts back the saved queue, paused where it was, with the volume', async () => {
    const first = setupTestPlayback({ persist: { queueDelayMs: 0 } })
    await first.player.setQueue(testTracks('a', 'b', 'c'), { startIndex: 1, autoplay: false })
    first.player.seek(42_000)
    first.player.setVolume(0.3)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).not.toBeNull()
    expect(localStorage.getItem(PLAYBACK_STORAGE_KEY)).not.toBeNull()

    const { player } = setupTestPlayback()

    expect(player).not.toBe(first.player)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 42_000, volume: 0.3 })
    expect(player.getState().queue.items.map((item) => item.track.title)).toEqual(['a', 'b', 'c'])
    expect(player.getState().queue.index).toBe(1)
  })

  it('puts the saved position back only on the item it was saved for, inside the track', async () => {
    const first = setupTestPlayback({ persist: { queueDelayMs: 0 } })
    await first.player.setQueue(testTracks('a', 'b'), { startIndex: 1, autoplay: false })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const save = (position: object) =>
      localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(position))

    // Written after the queue: the position of an item the saved queue doesn't have as current.
    save({ positionMs: 42_000, uid: 0 })
    expect(setupTestPlayback().player.getState().positionMs).toBe(0)

    save({ positionMs: 10_000_000, uid: 1 })
    expect(setupTestPlayback().player.getState()).toMatchObject({
      positionMs: 180_000,
      status: 'paused',
    })
  })

  it('re-renders components when the state changes, and when the player is replaced', async () => {
    function Status() {
      return <p>{usePlayerState((state) => `${state.status} ${state.queue.items.length}`)}</p>
    }
    const { player } = setupTestPlayback()
    render(<Status />)
    expect(screen.getByText('idle 0')).toBeInTheDocument()

    await act(() => player.setQueue(testTracks('a', 'b'), { autoplay: false }))
    expect(screen.getByText('paused 2')).toBeInTheDocument()

    act(() => {
      setupTestPlayback()
    })
    expect(screen.getByText('idle 0')).toBeInTheDocument()
  })
})

describe('the review list', () => {
  it('records the best guesses the policy reports for queued tracks', async () => {
    const { player, policy } = setupTestPlayback()
    const queued = spotifyTrack('Queued')
    await player.setQueue([queued], { autoplay: false })

    policy.reportNeedsReview(queued, testCandidate('q'))
    policy.reportNeedsReview(spotifyTrack('Gone'), testCandidate('g'))

    expect(useQueueReviewStore.getState().entries).toEqual({ [queued.id]: testCandidate('q') })
  })

  it('forgets tracks that leave the queue, and starts over in another mode', async () => {
    const { player, policy } = setupTestPlayback()
    const [a, b] = [spotifyTrack('A'), spotifyTrack('B')]
    await player.setQueue([a, b], { autoplay: false })
    policy.reportNeedsReview(a, testCandidate('a'))
    policy.reportNeedsReview(b, testCandidate('b'))

    player.remove(0)
    expect(Object.keys(useQueueReviewStore.getState().entries)).toEqual([b.id])

    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(useQueueReviewStore.getState().entries).toEqual({})
  })

  it('passes "Play best guesses" to the policy at start and on every change', () => {
    useQueueReviewStore.getState().setPlayBestGuesses(true)
    const { policy } = setupTestPlayback()
    expect(policy.playBestGuesses).toBe(true)

    useQueueReviewStore.getState().setPlayBestGuesses(false)

    expect(policy.playBestGuesses).toBe(false)
  })
})

describe('the pending policy', () => {
  it('stops playback with a clear error until stage 2.3 connects a resolver', async () => {
    const policy = createPendingPolicy()
    await expect(
      policy.resolver.resolve(
        { uid: 0, track: testTrack('a') },
        {
          reason: 'play',
          attempt: 0,
          signal: new AbortController().signal,
          canPlay: () => 'probably',
        },
      ),
    ).rejects.toEqual(new FxmError('Unsupported', PENDING_RESOLVER_MESSAGE))
    await expect(
      policy.alternatives(testTrack('a'), new AbortController().signal),
    ).resolves.toEqual([])
    expect(policy.onNeedsReview(() => {})).toBeTypeOf('function')
  })
})
