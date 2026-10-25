import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_ORIGINS, FEATURES, fxmOrigins, PRODUCTION_ORIGINS } from './config.ts'
import {
  buildRules,
  buildRulesets,
  CORS_RULE_SPECS,
  type DnrRule,
  type HeaderOperation,
  ruleFeatures,
  ruleHostPermissions,
} from './rules.ts'

const FXM = 'https://fxm-music.pages.dev'
const rules = buildRules(FXM)

function find(operations: HeaderOperation[], header: string): HeaderOperation | undefined {
  return operations.find((operation) => operation.header === header)
}

function setValue(operations: HeaderOperation[], header: string): string | undefined {
  const operation = find(operations, header)
  return operation?.operation === 'set' ? operation.value : undefined
}

function ruleNamed(name: string): DnrRule {
  const index = CORS_RULE_SPECS.findIndex((spec) => spec.name === name)
  const rule = rules[index]
  if (!rule) throw new Error(`no rule ${name}`)
  return rule
}

/** Hosts a rule can match: its requestDomains, or the host its URL filter is anchored to. */
function ruleHosts(rule: DnrRule): string[] {
  if (rule.condition.requestDomains) return rule.condition.requestDomains
  const match = /^\|https:\/\/([a-z0-9.-]+)\//.exec(rule.condition.urlFilter ?? '')
  if (!match?.[1]) throw new Error(`rule ${rule.id} has an unanchored URL filter`)
  return [match[1]]
}

/** Whether a host_permissions pattern such as https://*.googlevideo.com/* covers a host. */
function covers(pattern: string, host: string): boolean {
  const match = /^https:\/\/(\*\.)?([a-z0-9.-]+)\/\*$/.exec(pattern)
  if (!match?.[2]) return false
  return match[1] ? host === match[2] || host.endsWith(`.${match[2]}`) : host === match[2]
}

const YOUTUBE_RULES = ['youtube-www', 'youtube-music', 'youtube-api'].flatMap((name) => [
  name,
  `${name}-preflight`,
])

/** The request methods a rule matches: OPTIONS only, everything but OPTIONS, or all. */
function methods(rule: DnrRule): 'options' | 'not-options' | 'all' {
  if (rule.condition.requestMethods) return 'options'
  return rule.condition.excludedRequestMethods ? 'not-options' : 'all'
}

describe('CORS rules for the production origin', () => {
  it('has one rule per spec with unique IDs', () => {
    expect(rules).toHaveLength(CORS_RULE_SPECS.length)
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
    expect(rules.every((rule) => rule.priority === 1)).toBe(true)
  })

  it('scopes every rule to the FXM origin with initiatorDomains', () => {
    for (const rule of rules) {
      expect(rule.condition.initiatorDomains).toEqual(['fxm-music.pages.dev'])
    }
  })

  it('sets Access-Control-Allow-Origin to the exact FXM origin, never a wildcard', () => {
    for (const rule of rules) {
      expect(setValue(rule.action.responseHeaders, 'access-control-allow-origin')).toBe(FXM)
    }
    expect(JSON.stringify(rules)).not.toContain('"*"')
  })

  it('never sets credentials and strips cookies, Set-Cookie and upstream credential grants', () => {
    for (const rule of rules) {
      const all = [...rule.action.requestHeaders, ...rule.action.responseHeaders]
      expect(
        all.filter(
          (operation) =>
            operation.header === 'access-control-allow-credentials' &&
            operation.operation !== 'remove',
        ),
      ).toEqual([])
      expect(find(rule.action.requestHeaders, 'cookie')).toEqual({
        header: 'cookie',
        operation: 'remove',
      })
      expect(find(rule.action.responseHeaders, 'set-cookie')?.operation).toBe('remove')
      expect(find(rule.action.responseHeaders, 'access-control-allow-credentials')?.operation).toBe(
        'remove',
      )
    }
  })

  it('only targets hosts covered by host_permissions', () => {
    const permissions = ruleHostPermissions()
    for (const rule of rules) {
      for (const host of ruleHosts(rule)) {
        expect(
          permissions.some((pattern) => covers(pattern, host)),
          host,
        ).toBe(true)
      }
    }
  })

  it('only targets the music services FXM Connect exists for', () => {
    expect(new Set(rules.flatMap(ruleHosts))).toEqual(
      new Set([
        'www.youtube.com',
        'music.youtube.com',
        'youtubei.googleapis.com',
        'googlevideo.com',
        'open.spotify.com',
        'clienttoken.spotify.com',
        'api-partner.spotify.com',
        'spclient.wg.spotify.com',
        'www.last.fm',
      ]),
    )
    expect(ruleHostPermissions()).toEqual([
      'https://www.youtube.com/*',
      'https://music.youtube.com/*',
      'https://youtubei.googleapis.com/*',
      'https://*.googlevideo.com/*',
      'https://open.spotify.com/*',
      'https://clienttoken.spotify.com/*',
      'https://api-partner.spotify.com/*',
      'https://spclient.wg.spotify.com/*',
      'https://www.last.fm/*',
    ])
  })

  it('only modifies headers of API, media and preflight requests, never navigations', () => {
    for (const rule of rules) {
      expect(rule.action.type).toBe('modifyHeaders')
      for (const type of rule.condition.resourceTypes) {
        expect(['xmlhttprequest', 'media', 'other']).toContain(type)
      }
      // Exactly one way of matching the URL.
      expect(Boolean(rule.condition.requestDomains) !== Boolean(rule.condition.urlFilter)).toBe(
        true,
      )
    }
  })

  it('lets at most one rule modify any request', () => {
    for (const [index, rule] of rules.entries()) {
      for (const other of rules.slice(index + 1)) {
        const sameTarget =
          JSON.stringify(rule.condition.requestDomains ?? rule.condition.urlFilter) ===
          JSON.stringify(other.condition.requestDomains ?? other.condition.urlFilter)
        const sharedType = rule.condition.resourceTypes.some((type) =>
          other.condition.resourceTypes.includes(type),
        )
        const sharedMethod =
          methods(rule) === 'all' || methods(other) === 'all' || methods(rule) === methods(other)
        expect(sameTarget && sharedType && sharedMethod, `rules ${rule.id} and ${other.id}`).toBe(
          false,
        )
      }
    }
  })

  it('uses lower-case header names and only set or remove operations', () => {
    for (const rule of rules) {
      for (const operation of [...rule.action.requestHeaders, ...rule.action.responseHeaders]) {
        expect(operation.header).toBe(operation.header.toLowerCase())
        expect(['set', 'remove']).toContain(operation.operation)
      }
    }
  })

  // InnerTube answers a preflight with its own origin with 400, so preflights get the other one.
  it.each([
    ['youtube-www', 'www.youtube.com', 'https://www.youtube.com', 'https://music.youtube.com'],
    ['youtube-music', 'music.youtube.com', 'https://music.youtube.com', 'https://www.youtube.com'],
    [
      'youtube-api',
      'youtubei.googleapis.com',
      'https://www.youtube.com',
      'https://www.youtube.com',
    ],
  ])(
    'rewrites %s requests and preflights to YouTube origins',
    (name, host, origin, preflightOrigin) => {
      const request = ruleNamed(name)
      const preflight = ruleNamed(`${name}-preflight`)
      for (const rule of [request, preflight]) {
        expect(rule.condition.requestDomains).toEqual([host])
        expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest', 'other'])
      }
      expect(request.condition.excludedRequestMethods).toEqual(['options'])
      expect(setValue(request.action.requestHeaders, 'origin')).toBe(origin)
      expect(setValue(request.action.requestHeaders, 'referer')).toBe(`${origin}/`)
      expect(preflight.condition.requestMethods).toEqual(['options'])
      expect(setValue(preflight.action.requestHeaders, 'origin')).toBe(preflightOrigin)
      expect(setValue(preflight.action.requestHeaders, 'referer')).toBe(`${preflightOrigin}/`)
      expect(preflight.action.responseHeaders).toEqual(request.action.responseHeaders)
    },
  )

  it('lets the web app use the InnerTube headers and caches preflights for 10 minutes', () => {
    for (const name of YOUTUBE_RULES) {
      const headers = ruleNamed(name).action.responseHeaders
      expect(setValue(headers, 'access-control-allow-methods')).toBe('GET, POST, OPTIONS')
      expect(setValue(headers, 'access-control-allow-headers')?.split(', ')).toEqual([
        'content-type',
        'authorization',
        'x-goog-visitor-id',
        'x-youtube-client-name',
        'x-youtube-client-version',
        'x-goog-api-format-version',
        'x-origin',
        'x-youtube-bootstrap-logged-in',
        'x-browser-validation',
      ])
      expect(setValue(headers, 'access-control-expose-headers')).toBe('content-length')
      expect(setValue(headers, 'access-control-max-age')).toBe('600')
    }
  })

  it('exposes the media headers on googlevideo and rewrites the Origin only on preflights', () => {
    const media = ruleNamed('googlevideo-media')
    const preflight = ruleNamed('googlevideo-preflight')
    expect(media.condition.requestDomains).toEqual(['googlevideo.com'])
    expect(media.condition.resourceTypes).toEqual(['xmlhttprequest', 'media'])
    expect(media.condition.excludedRequestMethods).toEqual(['options'])
    expect(find(media.action.requestHeaders, 'origin')).toBeUndefined()
    expect(preflight.condition.requestMethods).toEqual(['options'])
    expect(setValue(preflight.action.requestHeaders, 'origin')).toBe('https://www.youtube.com')
    for (const rule of [media, preflight]) {
      expect(setValue(rule.action.responseHeaders, 'access-control-expose-headers')).toBe(
        'content-length, content-range, accept-ranges, content-type',
      )
    }
  })

  it('limits open.spotify.com to /api/token and /api/server-time', () => {
    expect(ruleNamed('spotify-token').condition.urlFilter).toBe(
      '|https://open.spotify.com/api/token^',
    )
    expect(ruleNamed('spotify-server-time').condition.urlFilter).toBe(
      '|https://open.spotify.com/api/server-time^',
    )
    const openRules = rules.filter((rule) => ruleHosts(rule).includes('open.spotify.com'))
    expect(openRules).toHaveLength(2)
  })

  it('makes Spotify token requests look like open.spotify.com and allows the Spotify headers', () => {
    for (const name of ['spotify-token', 'spotify-server-time', 'spotify-clienttoken']) {
      const rule = ruleNamed(name)
      expect(setValue(rule.action.requestHeaders, 'origin')).toBe('https://open.spotify.com')
      expect(setValue(rule.action.requestHeaders, 'referer')).toBe('https://open.spotify.com/')
    }
    for (const name of ['spotify-partner', 'spotify-spclient']) {
      expect(find(ruleNamed(name).action.requestHeaders, 'origin')).toBeUndefined()
    }
    for (const spec of CORS_RULE_SPECS.filter((spec) => spec.feature === 'spotify')) {
      const headers = ruleNamed(spec.name).action.responseHeaders
      expect(setValue(headers, 'access-control-allow-headers')).toBe(
        'authorization, content-type, client-token, app-platform, spotify-app-version, accept',
      )
      expect(setValue(headers, 'access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    }
  })

  it('only adds Access-Control-Allow-Origin to Last.fm station JSON', () => {
    const rule = ruleNamed('lastfm-station')
    expect(rule.condition.urlFilter).toBe('|https://www.last.fm/player/station/')
    expect(rule.action.requestHeaders).toEqual([{ header: 'cookie', operation: 'remove' }])
    expect(rule.action.responseHeaders.filter((op) => op.operation === 'set')).toEqual([
      { header: 'access-control-allow-origin', operation: 'set', value: FXM },
    ])
  })

  it('matches the reviewed rules.json', () => {
    expect(rules).toMatchSnapshot()
  })
})

describe('rulesets', () => {
  it('ships a single rules.json, enabled, in the production build', () => {
    const rulesets = buildRulesets(fxmOrigins(false))
    expect(
      rulesets.map(({ id, path, enabled, origin }) => ({ id, path, enabled, origin })),
    ).toEqual([{ id: 'fxm_music_pages_dev', path: 'rules.json', enabled: true, origin: FXM }])
    expect(rulesets[0]?.rules).toEqual(rules)
    expect(PRODUCTION_ORIGINS).toEqual([FXM])
  })

  it('adds a ruleset per localhost origin in the dev build, enabling one per host', () => {
    const rulesets = buildRulesets(fxmOrigins(true))
    expect(rulesets.map(({ id, path, enabled }) => ({ id, path, enabled }))).toEqual([
      { id: 'fxm_music_pages_dev', path: 'rules.json', enabled: true },
      { id: 'localhost_5173', path: 'rules-localhost_5173.json', enabled: true },
      { id: 'localhost_4173', path: 'rules-localhost_4173.json', enabled: false },
    ])
    for (const [index, origin] of DEVELOPMENT_ORIGINS.entries()) {
      for (const rule of rulesets[index + 1]?.rules ?? []) {
        expect(rule.condition.initiatorDomains).toEqual(['localhost'])
        expect(setValue(rule.action.responseHeaders, 'access-control-allow-origin')).toBe(origin)
      }
    }
  })

  it('rejects empty, duplicate and insecure origin lists', () => {
    expect(() => buildRulesets([])).toThrow()
    expect(() => buildRulesets([FXM, FXM])).toThrow()
    expect(() => buildRulesets(['http://fxm-music.pages.dev'])).toThrow(/HTTPS/)
  })
})

describe('features', () => {
  it('announces every rule group first, in order', () => {
    expect(FEATURES.slice(0, ruleFeatures().length)).toEqual(ruleFeatures())
    expect(ruleFeatures()).toEqual(['youtube', 'googlevideo', 'spotify', 'lastfm'])
  })
})
