import { describe, expect, it } from 'vitest'
import { serializePolicy } from './csp.ts'
import type { HeaderRule } from './headers-file.ts'
import { appPolicy, SANDBOX_DOCUMENTS } from './policies.ts'
import { isHostSource, policyHosts, privacyPageServices, privacyProblems } from './privacy.ts'
import { privacyPage } from './testing.ts'

const rule = (path: string, policy: string): HeaderRule => ({
  path,
  headers: [
    ['Content-Security-Policy', policy],
    ['Referrer-Policy', 'no-referrer'],
  ],
})

const RULES = [
  rule('/app/*', serializePolicy(appPolicy(["'sha256-x'"]))),
  rule('/sandbox/innertube', serializePolicy(SANDBOX_DOCUMENTS['innertube.html'](["'sha256-y'"]))),
  rule('/sandbox/userhost', serializePolicy(SANDBOX_DOCUMENTS['userhost.html'](["'sha256-z'"]))),
]

describe('privacyPageServices', () => {
  it('reads the service names from the privacy page’s description list', () => {
    expect(privacyPageServices(privacyPage(['YouTube', 'Spotify key source']))).toEqual(
      new Set(['YouTube', 'Spotify key source']),
    )
  })
})

describe('policyHosts', () => {
  it('collects the hosts a policy names, not keywords, schemes or hashes', () => {
    const hosts = policyHosts([
      rule(
        '/x',
        "default-src 'self'; img-src data: https: https://a.example *.b.example; connect-src wss://c.example",
      ),
    ])
    expect([...hosts.keys()]).toEqual(['https://a.example', '*.b.example', 'wss://c.example'])
    expect(isHostSource('https:')).toBe(false)
    expect(isHostSource("'sha256-abc='")).toBe(false)
  })
})

describe('privacyProblems', () => {
  it('passes when the page lists every service the policies name', () => {
    expect(privacyProblems(RULES, privacyPage())).toEqual([])
  })

  it('names each service the page is missing', () => {
    const page = privacyPage([
      'YouTube',
      'Spotify',
      'MusicBrainz',
      'Internet Archive',
      'LRCLIB',
      'SponsorBlock',
      'ListenBrainz',
      'Last.fm',
      'GitHub',
    ])
    expect(privacyProblems(RULES, page)).toEqual([
      "the privacy page doesn't list Jamendo, whose hosts the policies allow: add it to apps/site/src/pages/privacy.astro",
    ])
  })

  it('refuses a host no service owns', () => {
    const rules = [rule('/app/*', "default-src 'self'; connect-src https://unknown.example")]
    expect(privacyProblems(rules, privacyPage())).toEqual([
      'https://unknown.example (in /app/*) belongs to no service in APP_SERVICES (src/policies.ts)',
    ])
  })

  it('needs a privacy page with a list of services', () => {
    expect(privacyProblems(RULES, undefined)).toEqual(['the site has no privacy.html'])
    expect(privacyProblems(RULES, '<h1>Privacy</h1>')).toEqual([
      'privacy.html lists no services (no <dt> elements)',
    ])
  })
})
