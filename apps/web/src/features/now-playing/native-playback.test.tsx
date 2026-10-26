import { equalizerPreset } from '@fxm/core'
import { NativeEngine } from '@fxm/player'
import {
  createFakeFxmPlayer,
  FakeEngine,
  type FakeFxmPlayer,
  testTracks,
} from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAudioEffectsStore } from '../audio-effects/effects-store'
import { configurePlayback, getPlayback, resetPlayback } from './playback'
import { FakePolicy, setupTestPlayback } from './testing'

/** Lets pending promises and zero-delay timers run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/** Makes `plugin.attach` wait until the returned function is called: Media3 answering late. */
function holdAttach(plugin: FakeFxmPlayer): () => void {
  const attach = plugin.attach.bind(plugin)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  plugin.attach = async () => {
    await gate
    return attach()
  }
  return release
}

/** The app's playback on a native engine over `plugin`, as in the Android app. */
function nativePlayback(plugin: FakeFxmPlayer, persist = {}) {
  return configurePlayback({
    createEngine: () => new NativeEngine({ plugin, origin: 'https://localhost' }),
    policy: new FakePolicy(),
    mediaSession: false,
    recordPlays: false,
    persist,
    player: { retryDelaysMs: [0], stallTimeoutMs: 0 },
  })
}

/** Saves a queue of `titles`, paused on the second at 42 s, as an earlier visit leaves it. */
async function saveQueue(...titles: string[]) {
  const earlier = setupTestPlayback({ persist: { queueDelayMs: 0 } })
  await earlier.player.setQueue(testTracks(...titles), { startIndex: 1, autoplay: false })
  earlier.player.seek(42_000)
  await new Promise((resolve) => setTimeout(resolve, 10))
  resetPlayback()
}

const queueTitles = () =>
  getPlayback()
    .player.getState()
    .queue.items.map((item) => item.track.title)

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor
})

describe('the app’s playback in the Android app', () => {
  it('connects Media3 before it puts back the saved queue', async () => {
    await saveQueue('a', 'b', 'c')
    const plugin = createFakeFxmPlayer()
    const release = holdAttach(plugin)
    const playback = nativePlayback(plugin)
    await settle()
    // Media3 hasn't answered: its own queue could be the one to keep.
    expect(queueTitles()).toEqual([])
    release()
    await playback.ready
    expect(queueTitles()).toEqual(['a', 'b', 'c'])
    expect(playback.player.getState()).toMatchObject({ status: 'paused', positionMs: 42_000 })
    expect(plugin.calls[0]).toBe('attach')
  })

  it('keeps the queue Media3 played on with when the page came back', async () => {
    // A page played a, b and c on Media3, which moved on to b, and then the page died.
    const first = createFakeFxmPlayer()
    const before = nativePlayback(first, { queueDelayMs: 60_000 })
    await before.ready
    await before.player.setQueue(testTracks('a', 'b', 'c'))
    await settle()
    first.ready()
    first.advance()
    await settle()
    first.progress(30_000, 200_000)
    const session = await first.attach()
    first.detach()
    resetPlayback()
    // What the saved queue says is older than what Media3 plays.
    localStorage.clear()
    await saveQueue('x', 'y')
    const plugin = createFakeFxmPlayer({ session })
    const playback = nativePlayback(plugin)
    await playback.ready
    await settle()
    expect(queueTitles()).toEqual(['a', 'b', 'c'])
    expect(playback.player.getState()).toMatchObject({ status: 'playing', positionMs: 30_000 })
    expect(plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
  })

  it('keeps a queue the user started before Media3 answered', async () => {
    await saveQueue('a', 'b', 'c')
    const plugin = createFakeFxmPlayer()
    const release = holdAttach(plugin)
    const playback = nativePlayback(plugin)
    void playback.player.setQueue(testTracks('z'), { autoplay: false })
    release()
    await playback.ready
    expect(queueTitles()).toEqual(['z'])
  })

  it('plays through Media3 wherever the bridge has its plugin', async () => {
    const plugin = createFakeFxmPlayer()
    ;(globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { FxmPlayer: plugin },
    }
    const playback = configurePlayback({
      policy: new FakePolicy(),
      mediaSession: false,
      recordPlays: false,
    })
    await playback.ready
    expect(plugin.attached).toBe(true)
    await playback.player.setQueue(testTracks('a'))
    await settle()
    expect(plugin.calls.some((call) => call.startsWith('load:a'))).toBe(true)
    // Replacing the playback lets go of Media3 for the next one.
    resetPlayback()
    expect(plugin.calls.at(-1)).toBe('release')
  })

  it('hands on Android’s own network callbacks for the stream lifecycle', async () => {
    const plugin = createFakeFxmPlayer()
    const playback = nativePlayback(plugin)
    await playback.ready
    const changes: boolean[] = []
    const stop = playback.network?.subscribe(() =>
      changes.push(playback.network?.cellular ?? false),
    )
    plugin.changeNetwork(true)
    stop?.()
    expect(changes).toEqual([true])
  })

  it('applies the audio effects the user sets through Media3 (stage 8.1)', async () => {
    const plugin = createFakeFxmPlayer()
    const playback = nativePlayback(plugin)
    await playback.ready
    useAudioEffectsStore.getState().applyEqualizerPreset('rock')
    useAudioEffectsStore.getState().setPlaybackRate(1.25)
    await settle()
    expect(plugin.calls.filter((call) => call.startsWith('setEffects')).at(-1)).toBe(
      `setEffects:eq=${equalizerPreset('rock').gainsDb.join(',')} loudness=-14 speed=1.25`,
    )
    expect(playback.player.getState().playbackRate).toBe(1.25)
  })

  it('plays in the WebView when Media3’s service can’t be bound', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await saveQueue('a', 'b')
    const plugin = createFakeFxmPlayer()
    plugin.attach = async () => {
      throw Object.assign(new Error('The player service is not available'), {
        code: 'UNAVAILABLE',
      })
    }
    const webView = new FakeEngine()
    const playback = configurePlayback({
      createEngine: () => new NativeEngine({ plugin, origin: 'https://localhost' }),
      createFallbackEngine: () => webView,
      policy: new FakePolicy(),
      mediaSession: false,
      recordPlays: false,
      player: { retryDelaysMs: [0], stallTimeoutMs: 0 },
    })
    await playback.ready
    // The saved queue is back in the same player, which plays in the WebView from now on.
    expect(queueTitles()).toEqual(['a', 'b'])
    expect(getPlayback().player).toBe(playback.player)
    await playback.player.play()
    await settle()
    expect(webView.source?.item?.track.title).toBe('b')
    expect(webView.calls.find((call) => call.method === 'load')?.args[1]).toBe(42_000)
    expect(playback.player.getState().status).toBe('playing')
    expect(plugin.calls.some((call) => call.startsWith('load'))).toBe(false)
    // The stream lifecycle follows the WebView's network events, no longer Android's callbacks.
    expect(playback.network?.id.startsWith('native-')).toBe(false)
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('native player is unavailable'),
      expect.objectContaining({ code: 'Unavailable' }),
    )
    errors.mockRestore()
  })

  it('plays in the WebView elsewhere, at once', async () => {
    await saveQueue('a', 'b')
    const playback = configurePlayback({
      policy: new FakePolicy(),
      mediaSession: false,
      recordPlays: false,
    })
    // Restored before anything else could happen: no Media3 to wait for.
    expect(queueTitles()).toEqual(['a', 'b'])
    await playback.ready
    // The stream lifecycle follows the browser's events.
    expect(playback.network).toBeUndefined()
  })
})
