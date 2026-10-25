import { describe, expect, it } from 'vitest'
import {
  checkHttpsUrl,
  DEFAULT_SPOTIFY_CONFIG,
  loadSpotifyConfig,
  parseSpotifyConfig,
  SPOTIFY_OPERATIONS,
  SPOTIFY_SECRET_SOURCE_HOSTS,
} from './config'
import bundled from './spotify-config.json'

/** A deep copy of the bundled config to edit. */
function copy(): Record<string, unknown> & {
  endpoints: Record<string, unknown>
  operations: Record<string, unknown>
} {
  return JSON.parse(JSON.stringify(bundled))
}

describe('the bundled config', () => {
  it('has a cleanly sourced hash, with its source file, for every operation', () => {
    for (const name of SPOTIFY_OPERATIONS) {
      const operation = DEFAULT_SPOTIFY_CONFIG.operations[name]
      expect(operation?.sha256Hash, name).toMatch(/^[0-9a-f]{64}$/u)
      expect(operation?.observedIn, name).toMatch(/\.js$/u)
    }
  })

  it('points only at Spotify, and holds secret source URLs but no secret', () => {
    for (const url of Object.values(DEFAULT_SPOTIFY_CONFIG.endpoints)) {
      expect(new URL(url).hostname).toMatch(/(^|\.)spotify\.com$/u)
    }
    expect(DEFAULT_SPOTIFY_CONFIG.secretSources.length).toBeGreaterThan(0)
    for (const url of DEFAULT_SPOTIFY_CONFIG.secretSources) {
      expect(url).toMatch(/^https:\/\//u)
      expect(SPOTIFY_SECRET_SOURCE_HOSTS).toContain(new URL(url).hostname)
    }
    expect(JSON.stringify(bundled)).not.toMatch(/"secret"\s*:/u)
    expect(DEFAULT_SPOTIFY_CONFIG.userAgent).toMatch(/^Mozilla\/5\.0 /u)
  })

  it('never calls the official Web API', () => {
    expect(JSON.stringify(bundled)).not.toContain('api.spotify.com')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SPOTIFY_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SPOTIFY_CONFIG.operations)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SPOTIFY_CONFIG.endpoints)).toBe(true)
  })
})

describe('parseSpotifyConfig', () => {
  it('ignores unknown operations and fields, and may leave operations out', () => {
    const config = copy()
    config.operations = {
      futureOperation: { sha256Hash: 'f'.repeat(64) },
      getTrack: { sha256Hash: 'a'.repeat(64) },
    }
    config.extra = true
    const parsed = parseSpotifyConfig(config)
    expect(Object.keys(parsed.operations)).toEqual(['getTrack'])
    expect(parsed.operations.getTrack).toEqual({ sha256Hash: 'a'.repeat(64) })
  })

  const broken: Array<[string, (config: ReturnType<typeof copy>) => void, RegExp]> = [
    ['a non-object', () => {}, /must be an object/u],
    ['a bad version', (c) => Object.assign(c, { version: 0 }), /version/u],
    ['no endpoints', (c) => Object.assign(c, { endpoints: null }), /endpoints/u],
    [
      'an endpoint off Spotify',
      (c) => Object.assign(c.endpoints, { pathfinder: 'https://evil.example/q' }),
      /spotify\.com/u,
    ],
    [
      'a look-alike host',
      (c) =>
        Object.assign(c.endpoints, { token: 'https://open.spotify.com.evil.example/api/token' }),
      /spotify\.com/u,
    ],
    [
      'the official Web API',
      (c) => Object.assign(c.endpoints, { pathfinder: 'https://api.spotify.com/v1/search' }),
      /official Web API/u,
    ],
    [
      'plain http',
      (c) => Object.assign(c.endpoints, { spclient: 'http://spclient.wg.spotify.com' }),
      /https/u,
    ],
    ['a non-URL', (c) => Object.assign(c.endpoints, { serverTime: 'not a url' }), /not a URL/u],
    [
      'a secret source over http',
      (c) => Object.assign(c, { secretSources: ['http://x.test/s'] }),
      /https/u,
    ],
    [
      'a secret source on another host',
      (c) => Object.assign(c, { secretSources: ['https://tracker.example/secret.json'] }),
      /raw\.githubusercontent\.com/u,
    ],
    [
      'secret sources that are not a list',
      (c) => Object.assign(c, { secretSources: 'x' }),
      /list/u,
    ],
    [
      'a URL with a user name and password',
      (c) => Object.assign(c.endpoints, { token: 'https://user:pass@open.spotify.com/api/token' }),
      /user name or password/u,
    ],
    ['an empty User-Agent', (c) => Object.assign(c, { userAgent: ' ' }), /userAgent/u],
    [
      'a User-Agent with a line break',
      (c) => Object.assign(c, { userAgent: 'Mozilla/5.0\r\nX-Evil: 1' }),
      /printable ASCII/u,
    ],
    [
      'a User-Agent that is too long',
      (c) => Object.assign(c, { userAgent: `Mozilla/5.0 ${'x'.repeat(512)}` }),
      /512/u,
    ],
    ['no operations', (c) => Object.assign(c, { operations: [] }), /operations/u],
    [
      'a malformed hash',
      (c) => Object.assign(c.operations, { getTrack: { sha256Hash: 'ABC' } }),
      /getTrack/u,
    ],
  ]

  for (const [name, edit, message] of broken) {
    it(`refuses ${name}`, () => {
      const config = copy()
      edit(config)
      const value = name === 'a non-object' ? 'nope' : config
      expect(() => parseSpotifyConfig(value)).toThrow(message)
    })
  }

  it('normalizes URLs', () => {
    const config = copy()
    Object.assign(config.endpoints, { spclient: 'https://SPCLIENT.wg.spotify.com/' })
    expect(parseSpotifyConfig(config).endpoints.spclient).toBe('https://spclient.wg.spotify.com')
  })
})

describe('checkHttpsUrl', () => {
  it('can require a public host', () => {
    const rules = { publicHost: true }
    expect(checkHttpsUrl('https://example.org/s.json', 'x', rules)).toBe(
      'https://example.org/s.json',
    )
    for (const url of [
      'https://localhost/s.json',
      'https://app.localhost/s.json',
      'https://192.168.1.1/router-admin.json',
      'https://2130706433/s.json',
      'https://[::1]/s.json',
    ]) {
      expect(() => checkHttpsUrl(url, 'x', rules), url).toThrow(/public host/u)
    }
  })
})

describe('loadSpotifyConfig', () => {
  it('takes a valid config that is at least as new', () => {
    const newer = copy()
    newer.version = DEFAULT_SPOTIFY_CONFIG.version + 1
    newer.operations = { getTrack: { sha256Hash: 'b'.repeat(64) } }
    const loaded = loadSpotifyConfig(newer)
    expect(loaded.version).toBe(DEFAULT_SPOTIFY_CONFIG.version + 1)
    expect(loaded.operations.getTrack?.sha256Hash).toBe('b'.repeat(64))
  })

  it('keeps the fallback for an older or broken config', () => {
    const older = { ...copy(), version: 1 }
    const fallback = parseSpotifyConfig({ ...copy(), version: 2 })
    expect(loadSpotifyConfig(older, fallback)).toBe(fallback)
    expect(loadSpotifyConfig({ broken: true })).toBe(DEFAULT_SPOTIFY_CONFIG)
    expect(loadSpotifyConfig(undefined)).toBe(DEFAULT_SPOTIFY_CONFIG)
  })
})
