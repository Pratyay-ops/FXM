import { testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { announcePlayEnded, announcePlayStarted } from '../signals/play-events'
import type { AppScrobbling } from './scrobbling'
import { useScrobblingStore } from './scrobbling-store'
import { type LoadScrobbling, startScrobbling } from './start-scrobbling'

const TOKEN = '00000000-0000-4000-8000-000000000000'
const T0 = Date.UTC(2026, 9, 26, 9)
const track = testTrack('a')
const play: NewPlay = { track, playedAt: T0, playedMs: 180_000, completed: true, skipped: false }

/** A fake scrobbling module that records what it hears, loaded when `release` is called. */
function fakeScrobbling() {
  const heard: string[] = []
  const stop = vi.fn()
  let release: () => void = () => {}
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  const app: AppScrobbling = {
    listener: {
      started: (start) => heard.push(`started ${start.track.title}`),
      ended: (end) => heard.push(`ended ${end.track.title}`),
    },
    stop,
  }
  const load = vi.fn<LoadScrobbling>(async () => {
    await loaded
    return { runAppScrobbling: () => app }
  })
  return { heard, stop, load, release: () => release() }
}

/** Lets pending promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  useScrobblingStore.setState(useScrobblingStore.getInitialState(), true)
})

describe('startScrobbling', () => {
  it('loads nothing while no account is connected, plays or not', async () => {
    const scrobbling = fakeScrobbling()
    stops.push(startScrobbling(scrobbling.load))
    announcePlayStarted({ track, startedAt: T0 })
    announcePlayEnded(play)
    await settle()
    expect(scrobbling.load).not.toHaveBeenCalled()
  })

  it('loads once an account is connected, and hands it the plays in order', async () => {
    const scrobbling = fakeScrobbling()
    stops.push(startScrobbling(scrobbling.load))
    useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    expect(scrobbling.load).toHaveBeenCalledTimes(1)
    // Plays while it loads wait for it, in order.
    announcePlayStarted({ track, startedAt: T0 })
    announcePlayEnded(play)
    scrobbling.release()
    await settle()
    expect(scrobbling.heard).toEqual(['started a', 'ended a'])
    useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'someone else' })
    expect(scrobbling.load).toHaveBeenCalledTimes(1)
  })

  it('loads at start when an account is already connected', async () => {
    useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    const scrobbling = fakeScrobbling()
    stops.push(startScrobbling(scrobbling.load))
    expect(scrobbling.load).toHaveBeenCalledTimes(1)
  })

  it('tries loading again after a failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    const scrobbling = fakeScrobbling()
    scrobbling.load.mockRejectedValueOnce(
      new TypeError('Failed to fetch dynamically imported module'),
    )
    stops.push(startScrobbling(scrobbling.load))
    await settle()
    expect(error).toHaveBeenCalledWith('Scrobbling could not start', expect.any(TypeError))
    scrobbling.release()
    announcePlayEnded(play)
    await settle()
    expect(scrobbling.load).toHaveBeenCalledTimes(2)
    expect(scrobbling.heard).toEqual(['ended a'])
  })

  it('stops the running scrobbling, and hears nothing more', async () => {
    useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    const scrobbling = fakeScrobbling()
    const stop = startScrobbling(scrobbling.load)
    scrobbling.release()
    await settle()
    stop()
    expect(scrobbling.stop).toHaveBeenCalledTimes(1)
    announcePlayEnded(play)
    await settle()
    expect(scrobbling.heard).toEqual([])
  })
})
