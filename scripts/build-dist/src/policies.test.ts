import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMBED_HEADERS } from '../../../apps/web/embed/headers.ts'
import { pwaCspProblems } from '../../../apps/web/pwa/host.ts'
import { EMBED_SOURCES } from '../../../apps/web/src/embed/target.ts'
import { WIRED_SOURCES } from '../../../apps/web/src/embed/wired.ts'
import { HOST_RULES } from '../../../packages/platform/src/hosts.ts'
import { parsePolicy, serializePolicy, sha256Source, UNSAFE_EVAL, WASM_UNSAFE_EVAL } from './csp.ts'
import {
  APP_SCRIPT_EXTRAS,
  APP_SERVICES,
  appPolicy,
  COMMON_HEADERS,
  isSandboxDocument,
  offeredServices,
  PERMISSIONS_POLICY,
  PLAYER_FEATURES,
  permissionsPolicyProblems,
  policyProblems,
  ruleFamily,
  SANDBOX_DOCUMENTS,
  STATIC_FILE_POLICY,
  serviceProblems,
  sitePagePolicy,
} from './policies.ts'
import { isHostSource } from './privacy.ts'

const HASH = sha256Source('theme()')

/** The `/app/*` policy exactly as docs/PLAN.md (stage 2.8) prints it, with a real hash. */
const PLAN_APP_POLICY =
  "default-src 'self'; script-src 'self' 'sha256-…'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net https://sponsor.ajay.app; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'".replace(
    "'sha256-…'",
    HASH,
  )

/**
 * The hosts later stages added to `connect-src`: 8.2's scrobbling (ListenBrainz, Last.fm), 3.2's
 * recommendations on Home (ListenBrainz's labs API, Last.fm's stations, the Cover Art Archive)
 * and 8.4's library sync (GitHub).
 */
const LATER_CONNECT_HOSTS = [
  'https://api.listenbrainz.org',
  'https://labs.api.listenbrainz.org',
  'https://ws.audioscrobbler.com',
  'https://www.last.fm',
  'https://api.github.com',
  'https://coverartarchive.org',
]

/** The hosts later stages added to `img-src`: the Cover Art Archive's covers (3.2). */
const LATER_IMG_HOSTS = ['https://coverartarchive.org']

/**
 * What the app and the embed share today: the plan's policy, with the hosts later stages added
 * after its own, and workers from the app's own origin only (no `blob:`, which nothing uses:
 * WORKER_SOURCES).
 */
const SHARED_POLICY = PLAN_APP_POLICY.replace(
  "; frame-src 'self';",
  ` ${LATER_CONNECT_HOSTS.join(' ')}; frame-src 'self';`,
)
  .replace(
    'https://*.jamendo.com; media-src',
    `https://*.jamendo.com ${LATER_IMG_HOSTS.join(' ')}; media-src`,
  )
  .replace("worker-src 'self' blob:;", "worker-src 'self';")

/**
 * The `/embed/*` policy today: no frame-ancestors, no worker, and the hosts of the two services
 * the embed plays from, YouTube's and Internet Archive's, only.
 */
const EMBED_POLICY = `default-src 'self'; script-src 'self' ${HASH}; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://archive.org https://*.archive.org; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://archive.org https://*.archive.org; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`

/**
 * What 4.2 adds for the app alone, after each service's hosts: the exact image hosts it fetches
 * track covers from, each measured to allow it.
 */
const COVER_HOSTS = {
  youtube:
    'https://i.ytimg.com https://lh3.googleusercontent.com https://yt3.ggpht.com https://yt3.googleusercontent.com',
  spotify: 'https://i.scdn.co',
}

/**
 * The `/app/*` policy today: the shared one, with 4.2's 'wasm-unsafe-eval' for the ffmpeg core
 * and its cover hosts.
 */
const APP_POLICY = SHARED_POLICY.replace(
  `script-src 'self' ${HASH};`,
  `script-src 'self' ${HASH} ${WASM_UNSAFE_EVAL};`,
)
  .replace(
    'https://*.googlevideo.com https://open.spotify.com',
    `https://*.googlevideo.com ${COVER_HOSTS.youtube} https://open.spotify.com`,
  )
  .replace(
    'https://spclient.wg.spotify.com https://musicbrainz.org',
    `https://spclient.wg.spotify.com ${COVER_HOSTS.spotify} https://musicbrainz.org`,
  )

describe('csp helpers', () => {
  it('hashes inline code as browsers do, after normalizing line endings', () => {
    const expected = `'sha256-${createHash('sha256').update('a\nb').digest('base64')}'`
    expect(sha256Source('a\r\nb')).toBe(expected)
  })

  it('refuses a repeated directive or a source with a separator in it', () => {
    expect(() =>
      serializePolicy([
        ['a', []],
        ['a', []],
      ]),
    ).toThrow(/twice/)
    expect(() => serializePolicy([['img-src', ['x;y']]])).toThrow(/invalid source/)
  })

  it('parses one policy, refusing two joined with a comma', () => {
    expect(parsePolicy("default-src 'none'; img-src 'self' data:")).toEqual(
      new Map([
        ['default-src', ["'none'"]],
        ['img-src', ["'self'", 'data:']],
      ]),
    )
    expect(() => parsePolicy("default-src 'none', default-src 'self'")).toThrow(
      /more than one policy/,
    )
    expect(() => parsePolicy("img-src 'self'; img-src data:")).toThrow(/twice/)
  })
})

/** Every service, as a build with all of them (Jamendo's client_id included) offers them. */
const ALL = { services: APP_SERVICES }

/** The `/app/*` policy of a build without Jamendo's client_id: no Jamendo hosts. */
const WITHOUT_JAMENDO = APP_POLICY.replaceAll(' https://*.jamendo.com', '')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the web app policy', () => {
  it('is the policy docs/PLAN.md specifies for /app/*, with the hosts later stages added', () => {
    expect(APP_POLICY).not.toBe(PLAN_APP_POLICY)
    expect(serializePolicy(appPolicy([HASH], ALL))).toBe(APP_POLICY)
  })

  it('stays under the plan’s estimates, far below 2,000 characters', () => {
    expect(PLAN_APP_POLICY.length).toBeLessThan(850)
    // The plan expects about 1,200 once the later stages' hosts are in.
    expect(serializePolicy(appPolicy([HASH], ALL)).length).toBeLessThan(1_200)
  })

  it('lets only the app, never the embed, compile WebAssembly and fetch covers (4.2)', () => {
    const app = parsePolicy(serializePolicy(appPolicy([HASH], ALL)))
    expect(app.get('script-src')).toEqual(["'self'", HASH, WASM_UNSAFE_EVAL])
    expect(app.get('script-src')).not.toContain(UNSAFE_EVAL)
    expect(app.get('connect-src')).toEqual(
      expect.arrayContaining(['https://i.ytimg.com', 'https://i.scdn.co']),
    )
    const embed = serializePolicy(appPolicy([HASH], { ...ALL, embeddable: true }))
    expect(embed).toBe(EMBED_POLICY)
    expect(embed).not.toContain(WASM_UNSAFE_EVAL)
    expect(parsePolicy(embed).get('connect-src')).not.toContain('https://i.ytimg.com')
  })

  it('reads covers only from exact image hosts, keeping the wildcards to img-src', () => {
    const app = parsePolicy(serializePolicy(appPolicy([HASH], ALL)))
    const connect = app.get('connect-src') ?? []
    for (const wildcard of [
      'https://*.ytimg.com',
      'https://*.googleusercontent.com',
      'https://*.ggpht.com',
      'https://*.scdn.co',
      'https://*.spotifycdn.com',
    ]) {
      expect(connect, wildcard).not.toContain(wildcard)
      expect(app.get('img-src'), wildcard).toContain(wildcard)
    }
    for (const service of APP_SERVICES) {
      for (const host of service.appConnect ?? []) expect(host, host).not.toContain('*')
    }
  })

  it('allows Jamendo only in a build with its client_id, as the web app offers it', () => {
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', '')
    expect(serializePolicy(appPolicy([HASH]))).toBe(WITHOUT_JAMENDO)
    expect(offeredServices().map((service) => service.privacyName)).not.toContain('Jamendo')
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', 'public-id')
    expect(serializePolicy(appPolicy([HASH]))).toBe(APP_POLICY)
    expect(offeredServices({ VITE_FXM_JAMENDO_CLIENT_ID: '  ' }).length).toBe(
      APP_SERVICES.length - 1,
    )
    expect(offeredServices({ VITE_FXM_JAMENDO_CLIENT_ID: 'id' })).toEqual(APP_SERVICES)
  })

  it('takes later stages’ hosts and script sources from the lists', () => {
    const policy = parsePolicy(
      serializePolicy(
        appPolicy([HASH], {
          services: [
            ...APP_SERVICES,
            // A host no shipped stage uses yet: 3.2's, once the app calls its providers.
            { privacyName: 'Cover Art Archive', connect: ['https://coverartarchive.org'] },
          ],
          scriptExtras: [WASM_UNSAFE_EVAL],
        }),
      ),
    )
    expect(policy.get('connect-src')?.at(-1)).toBe('https://coverartarchive.org')
    expect(policy.get('script-src')).toEqual(["'self'", HASH, WASM_UNSAFE_EVAL])
    expect(APP_SCRIPT_EXTRAS).toEqual([WASM_UNSAFE_EVAL])
  })

  it("never allows 'unsafe-eval' or 'unsafe-inline' scripts", () => {
    expect(() => appPolicy([HASH], { scriptExtras: [UNSAFE_EVAL] })).toThrow(/never/)
    expect(() => appPolicy([HASH], { scriptExtras: ["'unsafe-inline'"] })).toThrow(/never/)
    expect(APP_SCRIPT_EXTRAS).not.toContain(UNSAFE_EVAL)
  })

  it('names only HTTPS hosts, each under the service the privacy page lists', () => {
    expect(serviceProblems()).toEqual([])
    for (const service of APP_SERVICES) {
      for (const host of [
        ...(service.connect ?? []),
        ...(service.img ?? []),
        ...(service.appConnect ?? []),
      ]) {
        expect(isHostSource(host)).toBe(true)
      }
    }
  })

  it('refuses a service with a host that is not plain HTTPS, at every build', () => {
    expect(
      serviceProblems([
        { privacyName: 'Plain', connect: ['http://plain.example'] },
        { privacyName: 'Wide', img: ['https:', 'https://*.example.com/path'] },
        { privacyName: ' ', connect: ['https://ok.example'] },
      ]),
    ).toEqual([
      'Plain: http://plain.example is not an HTTPS host such as https://example.com or https://*.example.com',
      'Wide: https: is not an HTTPS host such as https://example.com or https://*.example.com',
      'Wide: https://*.example.com/path is not an HTTPS host such as https://example.com or https://*.example.com',
      'a service in APP_SERVICES has no name',
    ])
  })
})

describe('policyProblems', () => {
  it('knows what each rule path serves', () => {
    expect(
      [
        '/app/*',
        '/embed/*',
        '/sandbox/innertube',
        '/sandbox/userhost.html',
        '/sandbox/eval',
        '/privacy',
        '/_astro/*',
      ].map(ruleFamily),
    ).toEqual(['app', 'embed', 'sandbox', 'sandbox', 'evaluator', 'site', 'site'])
  })

  it('accepts every policy make dist writes', () => {
    const sandbox = Object.entries(SANDBOX_DOCUMENTS).map(
      ([name, policy]) => [`/sandbox/${name.replace('.html', '')}`, policy([HASH])] as const,
    )
    for (const [path, policy] of [
      ['/app/*', appPolicy([HASH])],
      ['/embed/*', appPolicy([HASH], { embeddable: true })],
      ['/privacy', STATIC_FILE_POLICY],
      ...sandbox,
    ] as const) {
      expect(policyProblems(path, serializePolicy(policy)), path).toEqual([])
    }
  })

  it('reports policies joined from two rules', () => {
    expect(policyProblems('/privacy', "default-src 'none', default-src 'self'")).toEqual([
      'more than one policy (the value contains a comma)',
    ])
  })

  it("refuses 'unsafe-inline' scripts and framing of the app and the site", () => {
    expect(
      policyProblems('/app/*', "default-src 'self'; script-src 'self' 'unsafe-inline'"),
    ).toEqual(["script-src allows 'unsafe-inline'", `no "frame-ancestors 'none'"`])
    expect(policyProblems('/embed/*', "default-src 'self'; frame-ancestors 'none'")).toEqual([
      'frame-ancestors, which would stop the embed or Lite inside other sites',
    ])
  })
})

describe('the sandbox document policies', () => {
  it('are the policies docs/PLAN.md specifies', () => {
    const policies = Object.fromEntries(
      Object.entries(SANDBOX_DOCUMENTS).map(([name, policy]) => [
        name,
        serializePolicy(policy([HASH])),
      ]),
    )
    expect(policies).toEqual({
      'innertube.html': `sandbox allow-scripts; default-src 'none'; script-src ${HASH}; connect-src https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com; base-uri 'none'; form-action 'none'`,
      'userhost.html': `sandbox allow-scripts; default-src 'none'; script-src ${HASH}; connect-src https:; base-uri 'none'; form-action 'none'`,
      // 8.3 adds worker-src blob: for the plugin workers, which inherit connect-src 'none'.
      'eval.html': `sandbox allow-scripts; default-src 'none'; script-src ${HASH} 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'`,
    })
  })

  it('set no frame-ancestors, so Lite keeps working inside an embed on another site', () => {
    for (const policy of Object.values(SANDBOX_DOCUMENTS)) {
      expect(parsePolicy(serializePolicy(policy([HASH]))).has('frame-ancestors')).toBe(false)
    }
  })

  it('knows the three documents and nothing else', () => {
    expect(isSandboxDocument('innertube.html')).toBe(true)
    expect(isSandboxDocument('toString')).toBe(false)
    expect(isSandboxDocument('other.html')).toBe(false)
  })
})

describe('the site policies', () => {
  it('allow a page’s own inline code by hash, and its own files', () => {
    const policy = sitePagePolicy({
      scriptHashes: [HASH],
      styleHashes: [sha256Source('h1{}')],
      externalScripts: false,
      externalStyles: true,
    })
    expect(serializePolicy(policy)).toBe(
      `default-src 'none'; script-src ${HASH}; style-src 'self' ${sha256Source('h1{}')}; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
  })

  it('leave out script-src and style-src when a page has neither', () => {
    const policy = sitePagePolicy({
      scriptHashes: [],
      styleHashes: [],
      externalScripts: false,
      externalStyles: false,
    })
    expect(policy.map(([name]) => name)).toEqual([
      'default-src',
      'img-src',
      'frame-ancestors',
      'base-uri',
      'form-action',
    ])
  })

  it('allow nothing for files that are not pages', () => {
    expect(serializePolicy(STATIC_FILE_POLICY)).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
  })
})

describe('the app policy and the installable web app', () => {
  it('allows what the PWA needs: its service worker, manifest, icons and shell download', () => {
    expect(pwaCspProblems(serializePolicy(appPolicy([HASH])))).toEqual([])
    // The embed installs nothing and starts no worker.
    expect(pwaCspProblems(serializePolicy(appPolicy([HASH], { embeddable: true })))).toEqual([
      'worker-src',
    ])
  })
})

/** The service each source the embed can name loads from (EMBED_SOURCES). */
const SOURCE_SERVICES: Readonly<Record<string, string>> = {
  ytm: 'YouTube',
  yt: 'YouTube',
  archive: 'Internet Archive',
  jamendo: 'Jamendo',
}

describe('the embed policy', () => {
  it('allows the services of the sources the embed plays, and nothing else', () => {
    expect(Object.keys(SOURCE_SERVICES).sort()).toEqual([...EMBED_SOURCES].sort())
    const played = new Set([...WIRED_SOURCES].map((source) => SOURCE_SERVICES[source]))
    expect(
      APP_SERVICES.filter((service) => service.embed).map((service) => service.privacyName),
    ).toEqual(APP_SERVICES.map((service) => service.privacyName).filter((name) => played.has(name)))
    // Even in a build that offers every service, Jamendo's client_id included.
    const embed = parsePolicy(serializePolicy(appPolicy([HASH], { ...ALL, embeddable: true })))
    const allowed = [...(embed.get('connect-src') ?? []), ...(embed.get('img-src') ?? [])]
    for (const service of APP_SERVICES.filter((candidate) => !candidate.embed)) {
      for (const host of [...(service.connect ?? []), ...(service.img ?? [])]) {
        expect(allowed, `${service.privacyName}: ${host}`).not.toContain(host)
      }
    }
  })

  it('lets the embed start no worker, which it never does', () => {
    const embed = parsePolicy(serializePolicy(appPolicy([HASH], { embeddable: true })))
    expect(embed.get('worker-src')).toEqual(["'none'"])
    expect(parsePolicy(serializePolicy(appPolicy([HASH]))).get('worker-src')).toEqual(["'self'"])
  })
})

/**
 * Hosts the platform's host table lists that the web app's page never contacts, with why. The
 * browser transport refuses them before the policy would.
 */
const NOT_FROM_THE_PAGE: Readonly<Record<string, string>> = {
  'www.google.com':
    "BotGuard's interpreter (1.11) sends no CORS headers: only the desktop and Android apps read it",
  'itunes.apple.com': 'iTunes Search, which no web client calls',
}

/** Whether a policy source such as `https://*.example.com` allows a host-table row's hosts. */
function allowsRow(sources: readonly string[], host: string): boolean {
  return sources.some((source) => {
    const allowed = source.replace(/^https:\/\//, '')
    if (allowed === host) return true
    return allowed.startsWith('*.') && !host.startsWith('*.') && host.endsWith(allowed.slice(1))
  })
}

describe('the app policy and the platform’s host table', () => {
  it('lets the page reach every host the browser transport sends to from the page', () => {
    // A build with every service, as the table lists every host the app may contact.
    const connect = parsePolicy(serializePolicy(appPolicy([HASH], ALL))).get('connect-src') ?? []
    for (const rule of HOST_RULES) {
      if (Object.hasOwn(NOT_FROM_THE_PAGE, rule.host)) {
        expect(allowsRow(connect, rule.host), rule.host).toBe(false)
        continue
      }
      expect(allowsRow(connect, rule.host), `${rule.host} (${rule.hostClass})`).toBe(true)
    }
  })

  it('reads the table by host and wildcard, as CSP does', () => {
    expect(allowsRow(['https://*.archive.org'], '*.archive.org')).toBe(true)
    expect(allowsRow(['https://*.archive.org'], 'ia800.us.archive.org')).toBe(true)
    expect(allowsRow(['https://*.archive.org'], 'archive.org')).toBe(false)
    expect(allowsRow(['https://yt3.ggpht.com'], '*.ggpht.com')).toBe(false)
  })
})

describe('the headers of every response', () => {
  it('cut a page off from a cross-site opener and turn off features FXM never uses', () => {
    expect(COMMON_HEADERS).toEqual([
      ['Referrer-Policy', 'no-referrer'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Cross-Origin-Opener-Policy', 'same-origin'],
      [
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=()',
      ],
    ])
  })

  it('never turn off what the player may use', () => {
    expect(PLAYER_FEATURES).toEqual([
      'autoplay',
      'fullscreen',
      'picture-in-picture',
      'screen-wake-lock',
    ])
    expect(permissionsPolicyProblems(PERMISSIONS_POLICY)).toEqual([])
    for (const feature of PLAYER_FEATURES) expect(PERMISSIONS_POLICY).not.toContain(feature)
  })

  it("match the copy of the embed's rule that its browser tests send", () => {
    for (const [name, value] of COMMON_HEADERS) {
      expect(EMBED_HEADERS[name.toLowerCase()], name).toBe(value)
    }
    // Its policy too, without the app's theme-script hash, which the player doesn't need.
    expect(EMBED_HEADERS['content-security-policy']).toBe(
      serializePolicy(appPolicy([], { ...ALL, embeddable: true })),
    )
  })

  it('find a Permissions-Policy that turns off more, or allows something', () => {
    expect(
      permissionsPolicyProblems('camera=(), screen-wake-lock=(), clipboard-read=(), usb=*'),
    ).toEqual([
      'it turns off screen-wake-lock, which the player may use',
      "it turns off clipboard-read, which isn't one of the features FXM never uses",
      '"usb=*" doesn\'t turn a feature off (feature=())',
    ])
  })
})
