import * as bridge from '@fxm/desktop/bridge'
import {
  DESKTOP_URL_REFRESH_MARGIN_MS,
  DesktopAudioEngine,
  type DesktopShell,
  type MediaAction,
  type NowPlaying,
} from '@fxm/desktop/bridge'
import type { DirectAudioEngineOptions } from '@fxm/player'
import { testStream } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_CONNECTION, useConnection } from '../../features/connect/connection'
import { getPlayer, resetPlayback } from '../../features/now-playing/playback'
import { setUpDesktopPlayback } from './desktop'

afterEach(() => {
  resetPlayback()
  useConnection.setState(INITIAL_CONNECTION, true)
})

/**
 * The real bridge, recording the engines it creates and the options it creates them with, as
 * `setUpDesktopPlayback` loads it.
 */
function recordingBridge() {
  const engines: DesktopAudioEngine[] = []
  const options: (DirectAudioEngineOptions | undefined)[] = []
  const loadBridge = async () => ({
    createDesktopPlayback: (playback?: Parameters<typeof bridge.createDesktopPlayback>[0]) => {
      const desktop = bridge.createDesktopPlayback(playback)
      return {
        ...desktop,
        createEngine: (engineOptions?: DirectAudioEngineOptions) => {
          const engine = desktop.createEngine(engineOptions)
          engines.push(engine)
          options.push(engineOptions)
          return engine
        },
      }
    },
  })
  return { engines, options, loadBridge }
}

/** A desktop shell that records the tray and sends native events on request. */
function fakeShell() {
  const shown: NowPlaying[] = []
  const media = new Set<(action: MediaAction) => void>()
  const shell: DesktopShell = {
    environment: async () => ({ os: 'macos', osVersion: '15.5.0', tray: false }),
    setNowPlaying: async (now) => {
      shown.push(now)
    },
    onMediaAction(listener) {
      media.add(listener)
      return () => media.delete(listener)
    },
    onNetworkChange: () => () => {},
  }
  return {
    shell,
    shown,
    click: (action: MediaAction) => {
      for (const listener of media) listener(action)
    },
  }
}

describe('setUpDesktopPlayback', () => {
  it("builds the app's player with the desktop's engine, options, tray and lifecycle rules", async () => {
    const fake = fakeShell()
    const { engines, loadBridge } = recordingBridge()

    const lifecycle = await setUpDesktopPlayback({
      tauri: true,
      loadBridge,
      playback: { shell: fake.shell, locks: undefined, onError: () => {} },
    })
    const player = getPlayer()

    // The engine plays only probed URLs, with the real macOS version's codecs (stage 7.3).
    expect(engines).toHaveLength(1)
    expect(engines[0]).toBeInstanceOf(DesktopAudioEngine)
    // The lifecycle resolves URLs again an hour before they expire, on the native network.
    expect(lifecycle?.refreshBeforeExpiryMs).toBe(DESKTOP_URL_REFRESH_MARGIN_MS)
    expect(typeof lifecycle?.network.subscribe).toBe('function')
    // The tray follows the player, and its menu drives it.
    const toggle = vi.spyOn(player, 'toggle')
    fake.click('toggle')
    expect(toggle).toHaveBeenCalledOnce()
  })

  it("gives the desktop's engine the equalizer's readability rule (stage 8.1)", async () => {
    const fake = fakeShell()
    const { options, loadBridge } = recordingBridge()

    await setUpDesktopPlayback({
      tauri: true,
      loadBridge,
      playback: { shell: fake.shell, locks: undefined, onError: () => {} },
    })
    // The desktop app reaches YouTube natively, with every byte readable through Rust.
    useConnection.setState({
      platform: 'desktop',
      capabilities: { youtube: 'full', mediaBytes: true, spotify: 'anonymous', fileSystem: true },
    })

    const isReadable = options[0]?.isReadable
    expect(isReadable).toBeDefined()
    // Web Audio reads the user's files and the free sources, whose hosts send CORS headers…
    expect(isReadable?.(testStream('file', { url: 'blob:http://tauri.localhost/0f1e' }))).toBe(true)
    const archive = testStream('archive', { url: 'https://archive.org/download/item/01.flac' })
    expect(isReadable?.(archive)).toBe(true)
    // …but not googlevideo, which the webview loads without CORS until stage 7.6.
    const youtube = testStream('ytm', { url: 'https://rr1---sn-x.googlevideo.com/videoplayback' })
    expect(isReadable?.(youtube)).toBe(false)
  })

  it('does nothing in a browser, without downloading the bridge', async () => {
    const loadBridge = vi.fn()

    expect(await setUpDesktopPlayback({ tauri: false, loadBridge })).toBeUndefined()
    expect(loadBridge).not.toHaveBeenCalled()
  })
})
