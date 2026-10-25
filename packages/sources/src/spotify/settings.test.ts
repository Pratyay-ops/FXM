import type { NetworkCapabilities } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { capabilities } from './fixtures/testing'
import {
  canUseSpotifyAccount,
  DEFAULT_SPOTIFY_SETTINGS,
  isSpotifyAvailable,
  isSpotifyReachable,
  sanitizeSpotifySettings,
} from './settings'

const at = (spotify: NetworkCapabilities['spotify']) => ({ capabilities: capabilities(spotify) })

describe('Spotify settings and reachability', () => {
  it('is on by default', () => {
    expect(DEFAULT_SPOTIFY_SETTINGS).toEqual({ enabled: true })
    expect(Object.isFrozen(DEFAULT_SPOTIFY_SETTINGS)).toBe(true)
  })

  it('is available where reachable and switched on', () => {
    expect(isSpotifyAvailable(at('anonymous'))).toBe(true)
    expect(isSpotifyAvailable(at('account'))).toBe(true)
    expect(isSpotifyAvailable(at('unreachable'))).toBe(false)
    expect(isSpotifyAvailable(at('account'), { enabled: false })).toBe(false)
    expect(isSpotifyAvailable(at('account'), { enabled: true })).toBe(true)
  })

  it('fails closed on unknown capability values', () => {
    const stale = { capabilities: { ...capabilities('anonymous'), spotify: true } }
    expect(isSpotifyReachable(stale as never)).toBe(false)
  })

  it('knows when a login source exists', () => {
    expect(canUseSpotifyAccount(at('account'))).toBe(true)
    expect(canUseSpotifyAccount(at('anonymous'))).toBe(false)
  })

  it('reads stored settings, switching off only on an explicit false', () => {
    expect(sanitizeSpotifySettings({ enabled: false })).toEqual({ enabled: false })
    expect(sanitizeSpotifySettings({ enabled: true })).toEqual({ enabled: true })
    for (const value of [undefined, null, 'off', 0, {}, { enabled: 'no' }, []]) {
      expect(sanitizeSpotifySettings(value)).toEqual({ enabled: true })
    }
  })
})
