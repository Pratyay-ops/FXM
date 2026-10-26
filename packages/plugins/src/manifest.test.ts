import { HOST_RULES } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import {
  compareVersions,
  DEVELOPMENT_VERSION,
  hostOfUrl,
  isDeclaredUrl,
  normalizeHost,
  parseManifest,
  parseVersion,
  pluginSourceId,
  reservedServiceOf,
} from './manifest'
import { testPluginManifest } from './testing'

function parseError(value: unknown, appVersion?: string): unknown {
  try {
    parseManifest(value, appVersion === undefined ? {} : { appVersion })
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
      minFxmVersion: '0.1.0',
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

  it.each([
    'music.youtube.com',
    'www.youtube.com:8443',
    'youtubei.googleapis.com',
    'rr3---sn-abc.googlevideo.com',
    'open.spotify.com',
    'spclient.wg.spotify.com',
    'www.last.fm',
  ])('refuses %s, a host FXM reaches itself with its own privileges', (host) => {
    const error = parseError(testPluginManifest({ hosts: ['api.example.org', host] }))
    expect(isPluginError(error, 'invalid-manifest')).toBe(true)
    expect((error as Error).message).toMatch(/that FXM reaches itself: plugins can't use it/u)
  })

  it('allows FXM’s open services, whose requests go out as any page’s would', () => {
    const manifest = parseManifest(
      testPluginManifest({ hosts: ['musicbrainz.org', 'ia800.us.archive.org'] }),
    )
    expect(manifest.hosts).toEqual(['musicbrainz.org', 'ia800.us.archive.org'])
    expect(reservedServiceOf('musicbrainz.org')).toBeUndefined()
    expect(reservedServiceOf('music.youtube.com')?.service).toBe('YouTube Music')
  })

  it('follows the platform’s host table: privileged hosts refused, open ones allowed', () => {
    for (const rule of HOST_RULES) {
      const host = rule.host.startsWith('*.') ? `sample${rule.host.slice(1)}` : rule.host
      if (rule.hostClass === 'open') {
        expect(parseManifest(testPluginManifest({ hosts: [host] })).hosts, host).toEqual([host])
        expect(reservedServiceOf(host), host).toBeUndefined()
      } else {
        const error = parseError(testPluginManifest({ hosts: [host] }))
        expect(isPluginError(error, 'invalid-manifest'), host).toBe(true)
        expect(reservedServiceOf(`${host}:8443`)?.service, host).toBe(rule.service)
      }
    }
  })
})

describe('parseManifest with this FXM’s version', () => {
  it('refuses a plugin for a newer FXM as that, before any field a newer FXM may know', () => {
    for (const future of [
      { provides: ['search', 'home'] },
      { hosts: ['*.example.org'] },
      { requestsPerHour: 10_000 },
    ]) {
      const error = parseError(testPluginManifest({ minFxmVersion: '9.0.0', ...future }), '1.0.0')
      expect(isPluginError(error, 'needs-newer-fxm'), String(error)).toBe(true)
      expect((error as Error).message).toBe(
        'Test Catalog needs FXM 9.0.0 or later; this is FXM 1.0.0',
      )
    }
  })

  it('accepts what this FXM runs, and calls an unknown operation invalid only then', () => {
    expect(
      parseManifest(testPluginManifest({ minFxmVersion: '0.4.0' }), { appVersion: '0.4.0' }),
    ).toBeTruthy()
    const error = parseError(
      testPluginManifest({ minFxmVersion: '0.4.0', provides: ['search', 'home'] }),
      '1.0.0',
    )
    expect(isPluginError(error, 'invalid-manifest')).toBe(true)
    expect((error as Error).message).toMatch(/a plugin that needs a newer FXM says so/u)
  })

  it('runs any plugin in a development build, which reports 0.0.0', () => {
    expect(DEVELOPMENT_VERSION).toBe('0.0.0')
    expect(
      parseManifest(testPluginManifest({ minFxmVersion: '9.0.0' }), { appVersion: '0.0.0' })
        .minFxmVersion,
    ).toBe('9.0.0')
  })

  it('refuses an app version that is not one', () => {
    expect(() => parseManifest(testPluginManifest(), { appVersion: 'dev' })).toThrow(RangeError)
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
})
