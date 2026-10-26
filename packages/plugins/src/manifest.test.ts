import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import {
  checkCompatible,
  compareVersions,
  hostOfUrl,
  isDeclaredUrl,
  normalizeHost,
  parseManifest,
  parseVersion,
  pluginSourceId,
} from './manifest'
import { testPluginManifest } from './testing'

function parseError(value: unknown): unknown {
  try {
    parseManifest(value)
  } catch (error) {
    return error
  }
  return undefined
}

describe('parseManifest', () => {
  it('accepts the test plugin and returns it in its one spelling', () => {
    const manifest = parseManifest(
      testPluginManifest({
        hosts: ['Catalog.FXM-Plugin.test:443', 'catalog.fxm-plugin.test', 'cdn.example.org:8443'],
        provides: ['resolve', 'search', 'resolve'],
        sha256: 'A'.repeat(64),
        name: '  Test\n\tCatalog  ',
        unknownField: 'ignored',
      } as Record<string, unknown>),
    )
    expect(manifest).toEqual({
      fxmPlugin: 1,
      id: 'test-catalog',
      name: 'Test Catalog',
      version: '1.0.0',
      description: 'An invented catalog for FXM’s own tests.',
      author: 'FXM tests',
      license: 'Apache-2.0',
      minFxmVersion: '0.0.0',
      hosts: ['catalog.fxm-plugin.test', 'cdn.example.org:8443'],
      entry: 'plugin.js',
      sha256: 'a'.repeat(64),
      provides: ['search', 'resolve'],
      requestsPerHour: 120,
    })
    expect(pluginSourceId(manifest.id)).toBe('plugin.test-catalog')
  })

  it('fills in the request rate and leaves out what is absent', () => {
    const { requestsPerHour, description, author, license, ...rest } = testPluginManifest()
    const manifest = parseManifest({ ...rest, homepage: 'https://example.org/plugin' })
    expect(manifest.requestsPerHour).toBe(120)
    expect(manifest.homepage).toBe('https://example.org/plugin')
    expect(manifest).not.toHaveProperty('description')
  })

  it.each([
    ['not an object', null],
    ['a list', []],
    ['another API version', testPluginManifest({ fxmPlugin: 0 })],
    ['an ID with capitals', testPluginManifest({ id: 'Test' })],
    ['an ID with a dot', testPluginManifest({ id: 'a.b' })],
    ['an ID ending in a hyphen', testPluginManifest({ id: 'test-' })],
    ['an empty name', testPluginManifest({ name: '   ' })],
    ['a version with a pre-release', testPluginManifest({ version: '1.0.0-beta' })],
    ['a version with a leading zero', testPluginManifest({ version: '1.01.0' })],
    ['no minimum FXM version', testPluginManifest({ minFxmVersion: undefined })],
    ['an http home page', testPluginManifest({ homepage: 'http://example.org' })],
    ['hosts that are not a list', testPluginManifest({ hosts: 'example.org' })],
    [
      'too many hosts',
      testPluginManifest({ hosts: Array.from({ length: 17 }, (_, i) => `h${i}.example.org`) }),
    ],
    ['an absolute entry', testPluginManifest({ entry: 'https://elsewhere.example/plugin.js' })],
    ['a protocol-relative entry', testPluginManifest({ entry: '//elsewhere.example/plugin.js' })],
    ['an entry with a backslash', testPluginManifest({ entry: '..\\plugin.js' })],
    ['a short checksum', testPluginManifest({ sha256: 'abc' })],
    ['nothing it provides', testPluginManifest({ provides: [] })],
    ['an unknown operation', testPluginManifest({ provides: ['search', 'scrobble'] })],
    ['album without search', testPluginManifest({ provides: ['album', 'resolve'] })],
    ['match without resolve', testPluginManifest({ provides: ['match'] })],
    ['too many requests an hour', testPluginManifest({ requestsPerHour: 601 })],
    ['a fractional request rate', testPluginManifest({ requestsPerHour: 1.5 })],
  ])('refuses %s', (_, value) => {
    const error = parseError(value)
    expect(isPluginError(error, 'invalid-manifest')).toBe(true)
  })

  it('says so when a plugin was written for a newer plugin API', () => {
    const error = parseError(testPluginManifest({ fxmPlugin: 2 }))
    expect(isPluginError(error, 'unsupported-api')).toBe(true)
    expect((error as Error).message).toMatch(/version 2 of FXM's plugin API/u)
  })

  it('names the host it refuses', () => {
    const error = parseError(testPluginManifest({ hosts: ['192.168.1.1'] }))
    expect((error as Error).message).toMatch(/"192\.168\.1\.1", which is not a public host name/u)
  })
})

describe('normalizeHost', () => {
  it.each([
    ['api.example.org', 'api.example.org'],
    [' API.Example.ORG ', 'api.example.org'],
    ['api.example.org:443', 'api.example.org'],
    ['api.example.org:8443', 'api.example.org:8443'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['catalog.fxm-plugin.test', 'catalog.fxm-plugin.test'],
  ])('keeps %s as %s', (value, expected) => {
    expect(normalizeHost(value)).toBe(expected)
  })

  it.each([
    'localhost',
    'printer.local',
    'nas.home.arpa',
    'router.lan',
    'service.internal',
    'box.home',
    'example',
    '10.0.0.1',
    '1.2.3.4',
    '[::1]',
    '*.example.org',
    'bücher.example',
    'exa mple.org',
    '-bad.example.org',
    'api.example.org:0',
    'api.example.org:65536',
    'api.example.org:08',
    'api.example.org:',
    '',
    `${'a'.repeat(64)}.example.org`,
    42,
  ])('refuses %s', (value) => {
    expect(normalizeHost(value)).toBeUndefined()
  })
})

describe('URLs on declared hosts', () => {
  const hosts = ['api.example.org', 'cdn.example.org:8443']

  it('match exactly, over HTTPS, without credentials', () => {
    expect(isDeclaredUrl(hosts, 'https://api.example.org/x?y=1')).toBe(true)
    expect(isDeclaredUrl(hosts, 'https://API.example.org:443/x')).toBe(true)
    expect(isDeclaredUrl(hosts, 'https://cdn.example.org:8443/a.mp3')).toBe(true)
    expect(isDeclaredUrl(hosts, new URL('https://api.example.org/'))).toBe(true)
    for (const url of [
      'http://api.example.org/x',
      'https://cdn.example.org/a.mp3',
      'https://evil.example.org/x',
      'https://u:p@api.example.org/x',
      'data:text/plain,hi',
      'not a url',
    ]) {
      expect(isDeclaredUrl(hosts, url)).toBe(false)
    }
    expect(hostOfUrl(new URL('ftp://api.example.org/'))).toBeUndefined()
  })
})

describe('versions', () => {
  it('parses major.minor.patch and orders versions numerically', () => {
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0])
    expect(parseVersion('1.0')).toBeUndefined()
    expect(parseVersion(1)).toBeUndefined()
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(() => compareVersions('1', '1.0.0')).toThrow(RangeError)
  })

  it('checks the oldest FXM version a plugin runs on', () => {
    const manifest = parseManifest(testPluginManifest({ minFxmVersion: '0.4.0' }))
    expect(() => checkCompatible(manifest, '0.4.0')).not.toThrow()
    expect(() => checkCompatible(manifest, '1.0.0')).not.toThrow()
    let error: unknown
    try {
      checkCompatible(manifest, '0.3.9')
    } catch (caught) {
      error = caught
    }
    expect(isPluginError(error, 'needs-newer-fxm')).toBe(true)
    expect((error as Error).message).toBe(
      'Test Catalog needs FXM 0.4.0 or later; this is FXM 0.3.9',
    )
    expect(() => checkCompatible(manifest, 'dev')).toThrow(RangeError)
  })
})
