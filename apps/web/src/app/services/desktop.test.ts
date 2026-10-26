import * as bridge from '@fxm/desktop/bridge'
import {
  DESKTOP_URL_REFRESH_MARGIN_MS,
  DesktopAudioEngine,
  type DesktopShell,
  type MediaAction,
  type NowPlaying,
} from '@fxm/desktop/bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlayer, resetPlayback } from '../../features/now-playing/playback'
import { setUpDesktopPlayback } from './desktop'

afterEach(() => {
  resetPlayback()
})

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
    const engines: unknown[] = []
    // The real bridge, recording the engines it creates.
    const loadBridge = async () => ({
      createDesktopPlayback: (options?: Parameters<typeof bridge.createDesktopPlayback>[0]) => {
        const desktop = bridge.createDesktopPlayback(options)
        return {
          ...desktop,
          createEngine: () => {
            const engine = desktop.createEngine()
            engines.push(engine)
            return engine
          },
        }
      },
    })

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

  it('does nothing in a browser, without downloading the bridge', async () => {
    const loadBridge = vi.fn()

    expect(await setUpDesktopPlayback({ tauri: false, loadBridge })).toBeUndefined()
    expect(loadBridge).not.toHaveBeenCalled()
  })
})
