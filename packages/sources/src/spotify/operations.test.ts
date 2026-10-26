import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPOTIFY_CONFIG, parseSpotifyConfig, SPOTIFY_OPERATIONS } from './config'
import { isSpotifyError } from './errors'
import { OperationRegistry } from './operations'

describe('OperationRegistry', () => {
  it('gives the configured hash of every operation', () => {
    const registry = new OperationRegistry(DEFAULT_SPOTIFY_CONFIG)
    for (const name of SPOTIFY_OPERATIONS) {
      expect(registry.hashOf(name)).toBe(DEFAULT_SPOTIFY_CONFIG.operations[name]?.sha256Hash)
      expect(registry.isAvailable(name)).toBe(true)
    }
  })

  it('keeps an operation without a cleanly sourced hash disabled', () => {
    const config = parseSpotifyConfig({
      ...DEFAULT_SPOTIFY_CONFIG,
      operations: { getTrack: DEFAULT_SPOTIFY_CONFIG.operations.getTrack },
    })
    const registry = new OperationRegistry(config)
    expect(registry.isAvailable('searchDesktop')).toBe(false)
    let error: unknown
    try {
      registry.hashOf('searchDesktop')
    } catch (e) {
      error = e
    }
    expect(isSpotifyError(error, 'operation-unsupported')).toBe(true)
    expect(error).toMatchObject({ code: 'Unsupported' })
    expect(registry.hashOf('getTrack')).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('marks operations broken for the session, and can forget it', () => {
    const onChange = vi.fn()
    const registry = new OperationRegistry(DEFAULT_SPOTIFY_CONFIG, onChange)
    registry.markBroken('home')
    registry.markBroken('home')
    registry.markBroken('getAlbum')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(registry.broken()).toEqual(['home', 'getAlbum'])
    expect(registry.isAvailable('home')).toBe(false)
    expect(() => registry.hashOf('home')).toThrow(/rejected the operation home/u)
    registry.reset()
    registry.reset()
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(registry.broken()).toEqual([])
    expect(registry.isAvailable('home')).toBe(true)
  })

  it('forgets a broken mark when a newer config changes that hash', () => {
    const onChange = vi.fn()
    const registry = new OperationRegistry(DEFAULT_SPOTIFY_CONFIG, onChange)
    registry.markBroken('getTrack')
    registry.markBroken('getAlbum')
    const operations = {
      ...DEFAULT_SPOTIFY_CONFIG.operations,
      getTrack: { sha256Hash: 'a'.repeat(64) },
    }
    const newer = parseSpotifyConfig({ ...DEFAULT_SPOTIFY_CONFIG, version: 2, operations })
    onChange.mockClear()
    registry.setConfig(newer)
    expect(registry.broken()).toEqual(['getAlbum'])
    expect(registry.hashOf('getTrack')).toBe('a'.repeat(64))
    expect(onChange).toHaveBeenCalledTimes(1)
    // Nothing changes for the operations that are still broken.
    registry.setConfig(newer)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
