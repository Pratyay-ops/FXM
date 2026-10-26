import { DEFAULT_AUDIO_EFFECTS } from '@fxm/core'
import { DirectAudioEngine, Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_CONNECTION, useConnection } from '../connect/connection'
import { useFeedbackStore } from '../search/feedback'
import {
  connectAudioEffects,
  createAppEngine,
  isReadableHere,
  SLEEP_MESSAGE,
  sleepRequestOf,
} from './connect'
import { createAudioEffectsStore } from './effects-store'

function setup() {
  const engine = new FakeEngine()
  const player = new Player({ engine, resolver: new FakeResolver() })
  const store = createAudioEffectsStore({ storage: () => undefined, now: () => Date.now() })
  const disconnect = connectAudioEffects(player, store, () => Date.now())
  return { engine, player, store, disconnect }
}

afterEach(() => {
  vi.useRealTimers()
  useConnection.setState(INITIAL_CONNECTION, true)
})

describe('connectAudioEffects', () => {
  it('gives the player the settings now and on every change', () => {
    const { engine, player, store } = setup()
    expect(player.getAudioEffects()).toEqual(DEFAULT_AUDIO_EFFECTS)
    store.getState().applyEqualizerPreset('pop')
    expect(engine.effects?.equalizer.preset).toBe('pop')
    store.getState().setPlaybackRate(1.5)
    expect(player.getState().playbackRate).toBe(1.5)
    store.getState().setCrossfadeMs(5000)
    expect(player.getAudioEffects().crossfade.durationMs).toBe(5000)
  })

  it('runs the sleep timer on the player, and ends it when the player pauses', async () => {
    vi.useFakeTimers()
    const { player, store } = setup()
    await player.setQueue(testTracks('a', 'b'))
    store.getState().sleepAfter(1)
    expect(player.getState().sleepTimer).toMatchObject({ fadeMs: 12_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(player.getState().status).toBe('paused')
    expect(store.getState().sleepTimer).toBeUndefined()
    expect(useFeedbackStore.getState().message).toBe(SLEEP_MESSAGE)
  })

  it('ends the timer quietly when nothing plays at its time', async () => {
    vi.useFakeTimers()
    const { player, store } = setup()
    await player.setQueue(testTracks('a', 'b'))
    store.getState().sleepAfter(1)
    player.pause()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(player.getState().sleepTimer).toBeUndefined()
    // Settings and the Sound dialog show the store's timer: it ended too.
    expect(store.getState().sleepTimer).toBeUndefined()
    expect(useFeedbackStore.getState().message).toBe('')
  })

  it('ends the timer when an engine’s own timer ends it, saying so only if it paused', async () => {
    const engine = new FakeEngine()
    Object.assign(engine, { setSleepTimer: () => {} })
    const player = new Player({ engine, resolver: new FakeResolver() })
    const store = createAudioEffectsStore({ storage: () => undefined })
    connectAudioEffects(player, store)
    await player.setQueue(testTracks('a'))
    store.getState().sleepAtEndOfTrack()
    player.pause()
    engine.emit('sleep', { reason: 'end-of-track' })
    expect(store.getState().sleepTimer).toBeUndefined()
    expect(useFeedbackStore.getState().message).toBe('')
  })

  it('passes the end-of-track timer, and cancelling', () => {
    const { player, store } = setup()
    store.getState().sleepAtEndOfTrack()
    expect(player.getState().sleepTimer).toEqual({ endOfTrack: true })
    store.getState().cancelSleepTimer()
    expect(player.getState().sleepTimer).toBeUndefined()
  })

  it('stops following the store, and cancels the timer, when disconnected', () => {
    const { player, store, disconnect } = setup()
    store.getState().sleepAtEndOfTrack()
    disconnect()
    expect(player.getState().sleepTimer).toBeUndefined()
    store.getState().setPlaybackRate(2)
    expect(player.getState().playbackRate).toBe(1)
  })

  it('gives a player made later the timer that runs', () => {
    const store = createAudioEffectsStore({ storage: () => undefined, now: () => 1000 })
    store.getState().sleepAfter(10)
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    connectAudioEffects(player, store, () => 61_000)
    // 10 minutes from 1000, asked at 61 000: 9 minutes left.
    const timer = player.getState().sleepTimer
    expect(timer !== undefined && 'endsAt' in timer ? timer.fadeMs : undefined).toBe(12_000)
  })
})

describe('sleepRequestOf', () => {
  it('turns the setting into the player’s request', () => {
    expect(sleepRequestOf(undefined, 0)).toBeNull()
    expect(sleepRequestOf({ endOfTrack: true }, 0)).toEqual({ endOfTrack: true })
    expect(sleepRequestOf({ endsAt: 10_000, minutes: 1 }, 4000)).toEqual({ afterMs: 6000 })
    expect(sleepRequestOf({ endsAt: 10_000, minutes: 1 }, 20_000)).toEqual({ afterMs: 0 })
  })
})

describe('the app engine', () => {
  it('reads googlevideo only with FXM Connect in a browser', () => {
    const stream = { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=251' }
    expect(isReadableHere(stream)).toBe(false)
    useConnection.setState({
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true, spotify: 'anonymous', fileSystem: false },
    })
    expect(isReadableHere(stream)).toBe(true)
    useConnection.setState({ platform: 'desktop' })
    expect(isReadableHere(stream)).toBe(false)
    expect(isReadableHere({ url: 'https://archive.org/download/item/01.flac' })).toBe(true)
  })

  it('is a direct audio engine', () => {
    const engine = createAppEngine({ createAudioContext: null })
    expect(engine).toBeInstanceOf(DirectAudioEngine)
    engine.destroy()
  })
})
