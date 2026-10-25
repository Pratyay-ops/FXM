import { currentQueueItem, formatId } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediaActionsStore, playbackFromPlayer } from './actions'

let player: Player | undefined

afterEach(() => {
  player?.destroy()
  player = undefined
})

function createPlayer() {
  player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver(), preload: false })
  return player
}

describe('playbackFromPlayer', () => {
  it('starts a queue on the player facade, from a track and with its context', async () => {
    const facade = createPlayer()
    const playback = playbackFromPlayer(facade)
    const tracks = testTracks('a', 'b', 'c')
    const context = { type: 'album', id: formatId('ytm', 'album', 'x'), title: 'X' } as const

    playback.play(tracks, { startIndex: 1, context })

    await vi.waitFor(() => expect(facade.getState().status).toBe('playing'))
    const { queue } = facade.getState()
    expect(currentQueueItem(queue)?.track.title).toBe('b')
    expect(queue.context).toEqual(context)
  })

  it('queues next and last, and shuffles', async () => {
    const facade = createPlayer()
    const playback = playbackFromPlayer(facade)

    playback.play(testTracks('a', 'b'))
    await vi.waitFor(() => expect(facade.getState().status).toBe('playing'))
    playback.playNext(testTracks('next'))
    playback.addToQueue(testTracks('last'))

    expect(facade.getState().queue.items.map((item) => item.track.title)).toEqual([
      'a',
      'next',
      'b',
      'last',
    ])

    playback.play(testTracks('x', 'y', 'z'), { shuffle: true })
    await vi.waitFor(() => expect(facade.getState().queue.shuffle).toBe(true))
  })
})

describe('createMediaActionsStore', () => {
  it('swaps the actions and tells subscribers', () => {
    const store = createMediaActionsStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const playback = playbackFromPlayer(createPlayer())

    store.set({ ...store.get(), playback })

    expect(store.get().playback).toBe(playback)
    expect(listener).toHaveBeenCalledOnce()
  })
})
