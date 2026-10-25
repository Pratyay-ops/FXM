import type { NetworkCapabilities } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { capabilities } from './fixtures/testing'
import {
  DEFAULT_SPOTIFY_SETTINGS,
  hasSpotifyLoginSource,
  isSpotifyAvailable,
  isSpotifyReachable,
  sanitizeSpotifySettings,
} from './settings'

const at = (spotify: NetworkCapabilities['spotify']) => ({ capabilities: capabilities(spotify) })

describe('Spotify settings and reachability', () => {
  it('is on by default, with the account not connected', () => {
    expect(DEFAULT_SPOTIFY_SETTINGS).toEqual({ enabled: true, account: false })
    expect(Object.isFrozen(DEFAULT_SPOTIFY_SETTINGS)).toBe(true)
  })

  it('is available where reachable and switched on', () => {
    const on = DEFAULT_SPOTIFY_SETTINGS
    expect(isSpotifyAvailable(at('anonymous'), on)).toBe(true)
    expect(isSpotifyAvailable(at('account'), on)).toBe(true)
    expect(isSpotifyAvailable(at('unreachable'), on)).toBe(false)
    expect(isSpotifyAvailable(at('account'), { enabled: false })).toBe(false)
    expect(isSpotifyAvailable(at('account'), sanitizeSpotifySettings({ enabled: false }))).toBe(
      false,
    )
  })

  it('fails closed on unknown capability values', () => {
    const stale = { capabilities: { ...capabilities('anonymous'), spotify: true } }
    expect(isSpotifyReachable(stale as never)).toBe(false)
  })

  it('knows when a login source exists', () => {
    expect(hasSpotifyLoginSource(at('account'))).toBe(true)
    expect(hasSpotifyLoginSource(at('anonymous'))).toBe(false)
  })

  it('reads stored settings: off only on an explicit false, connected only on an explicit true', () => {
    expect(sanitizeSpotifySettings({ enabled: false })).toEqual({ enabled: false, account: false })
    expect(sanitizeSpotifySettings({ enabled: true, account: true })).toEqual({
      enabled: true,
      account: true,
    })
    for (const value of [undefined, null, 'off', 0, {}, { enabled: 'no', account: 'yes' }, []]) {
      expect(sanitizeSpotifySettings(value)).toEqual({ enabled: true, account: false })
    }
  })
})
