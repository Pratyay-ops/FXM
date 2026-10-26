/**
 * The Content-Security-Policies `make dist` writes into `_headers` (docs/PLAN.md, stage 2.8).
 *
 * A stage that makes the web app contact a new service adds it to APP_SERVICES, with the name
 * the site's privacy page gives it, and names it on that page (Definition of done). Nothing
 * else changes: the `/app/*` and `/embed/*` rules are built from these lists, and `make dist`
 * fails when a host in a policy has no service here or the privacy page doesn't list it.
 */
import {
  type Directive,
  NONE,
  type Policy,
  parsePolicy,
  SELF,
  UNSAFE_EVAL,
  UNSAFE_INLINE,
  unique,
  WASM_UNSAFE_EVAL,
} from './csp.ts'

/** A third-party service the web app contacts, and the hosts the app's policy allows for it. */
export interface Service {
  /** The service's name exactly as the privacy page lists it (apps/site/src/pages/privacy.astro). */
  readonly privacyName: string
  /** connect-src: hosts the app fetches from. */
  readonly connect?: readonly string[]
  /** img-src: hosts the app shows images from. */
  readonly img?: readonly string[]
}

/** YouTube's API hosts (InnerTube): the app with FXM Connect, and the Lite sandbox document. */
export const INNERTUBE_HOSTS = [
  'https://www.youtube.com',
  'https://music.youtube.com',
  'https://youtubei.googleapis.com',
] as const

/**
 * Every service the web app and the embed contact, in the order their hosts appear in the
 * policy. Only what shipped stages use (docs/PLAN.md, the notes on the `/app/*` rule). Stages
 * add theirs when they ship:
 *
 * - 1.11: the BotGuard hosts, once one of its rungs is on.
 *
 * 3.2's recommendation providers, which Home calls since stage 2.9b wired it, added their hosts
 * from the table in packages/sources/src/recommend/README.md: ListenBrainz's labs API, Last.fm's
 * stations (FXM Connect only) and the Cover Art Archive (whose redirects go to Internet
 * Archive's hosts, already here). Not iTunes Search, which the app doesn't call, nor the plan's
 * `lastfm.freetls.fastly.net`, which no provider contacts.
 *
 * Audio needs no entry: `media-src https:` covers googlevideo, Internet Archive's and Jamendo's
 * storage hosts and a user's Invidious proxy, and page script can't read media responses.
 */
export const APP_SERVICES: readonly Service[] = [
  {
    privacyName: 'YouTube',
    connect: [...INNERTUBE_HOSTS, 'https://*.googlevideo.com'],
    img: ['https://*.ytimg.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
  },
  {
    // Built in and on by default (Decision 1, option A). The secret source goes through the
    // sandbox's userhost.html, and clienttoken is not needed today.
    privacyName: 'Spotify',
    connect: [
      'https://open.spotify.com',
      'https://api-partner.spotify.com',
      'https://spclient.wg.spotify.com',
    ],
    img: ['https://*.scdn.co', 'https://*.spotifycdn.com'],
  },
  { privacyName: 'MusicBrainz', connect: ['https://musicbrainz.org'] },
  {
    privacyName: 'Internet Archive',
    connect: ['https://archive.org', 'https://*.archive.org'],
    img: ['https://archive.org', 'https://*.archive.org'],
  },
  { privacyName: 'Jamendo', connect: ['https://*.jamendo.com'], img: ['https://*.jamendo.com'] },
  { privacyName: 'LRCLIB', connect: ['https://lrclib.net'] },
  // 8.7: opt-in, and only for videos in Music + Video mode.
  { privacyName: 'SponsorBlock', connect: ['https://sponsor.ajay.app'] },
  // 8.2: scrobbling, once the user connects an account in Settings (the write APIs); 3.2:
  // Home's recommendations (ListenBrainz's similar artists, Last.fm's stations).
  {
    privacyName: 'ListenBrainz',
    connect: ['https://api.listenbrainz.org', 'https://labs.api.listenbrainz.org'],
  },
  { privacyName: 'Last.fm', connect: ['https://ws.audioscrobbler.com', 'https://www.last.fm'] },
  // 8.4: library sync, only once the user turns it on, with a secret gist on their account.
  { privacyName: 'GitHub', connect: ['https://api.github.com'] },
  // 3.2: covers for Home's songs that come without one.
  {
    privacyName: 'Cover Art Archive',
    connect: ['https://coverartarchive.org'],
    img: ['https://coverartarchive.org'],
  },
]

/**
 * Extra script-src sources for the web app and the embed. 4.2 adds WASM_UNSAFE_EVAL here for
 * ffmpeg.wasm in its worker. Never UNSAFE_EVAL or UNSAFE_INLINE: appPolicy() refuses them.
 */
export const APP_SCRIPT_EXTRAS: readonly string[] = []

/** An HTTPS origin, optionally with a `*.` sub-domain wildcard, and nothing else. */
const HTTPS_HOST = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/

/**
 * Why a service list can't go into the deployed policies (an empty list when it can): `make
 * dist` checks this at every build, not only in the tests, because these hosts end up in
 * production's policy.
 */
export function serviceProblems(services: readonly Service[] = APP_SERVICES): string[] {
  const problems: string[] = []
  for (const service of services) {
    if (!/\S/.test(service.privacyName)) problems.push('a service in APP_SERVICES has no name')
    for (const host of [...(service.connect ?? []), ...(service.img ?? [])]) {
      if (!HTTPS_HOST.test(host)) {
        problems.push(
          `${service.privacyName}: ${host} is not an HTTPS host such as https://example.com or https://*.example.com`,
        )
      }
    }
  }
  return problems
}

const COMMON_DOCUMENT_DIRECTIVES: readonly Directive[] = [
  ['base-uri', [NONE]],
  ['form-action', [NONE]],
]

/**
 * The web app's policy (`/app/*`), or the embed's (`/embed/*`): the same without
 * `frame-ancestors`, because any site may embed the player.
 */
export function appPolicy(
  scriptHashes: readonly string[],
  options: {
    embeddable?: boolean
    services?: readonly Service[]
    scriptExtras?: readonly string[]
  } = {},
): Policy {
  const services = options.services ?? APP_SERVICES
  const extras = options.scriptExtras ?? APP_SCRIPT_EXTRAS
  for (const source of extras) {
    if (source === UNSAFE_EVAL || source === UNSAFE_INLINE) {
      throw new Error(`the web app's script-src must never allow ${source}`)
    }
  }
  const connect = unique(services.flatMap((service) => service.connect ?? []))
  const img = unique(services.flatMap((service) => service.img ?? []))
  return [
    ['default-src', [SELF]],
    ['script-src', unique([SELF, ...scriptHashes, ...extras])],
    ['worker-src', [SELF, 'blob:']],
    ['style-src', [SELF, UNSAFE_INLINE]],
    ['img-src', [SELF, 'data:', 'blob:', ...img]],
    ['media-src', [SELF, 'blob:', 'https:']],
    ['connect-src', [SELF, ...connect]],
    ['frame-src', [SELF]],
    ...(options.embeddable ? [] : [['frame-ancestors', [NONE]] as const]),
    ...COMMON_DOCUMENT_DIRECTIVES,
    ['object-src', [NONE]],
  ]
}

/** The sandbox documents FXM publishes at `/sandbox/` (1.10, 1.11) and their policies. */
export const SANDBOX_DOCUMENTS = {
  /** 1.10: CORS-simple InnerTube POSTs from an opaque origin (the Lite tier). */
  'innertube.html': (scriptHashes: readonly string[]): Policy => [
    ['sandbox', ['allow-scripts']],
    ['default-src', [NONE]],
    ['script-src', scriptHashes],
    ['connect-src', [...INNERTUBE_HOSTS]],
    ...COMMON_DOCUMENT_DIRECTIVES,
  ],
  /** 1.10: GET-only fetches to hosts the user configures (an Invidious instance, the Spotify secret source). */
  'userhost.html': (scriptHashes: readonly string[]): Policy => [
    ['sandbox', ['allow-scripts']],
    ['default-src', [NONE]],
    ['script-src', scriptHashes],
    ['connect-src', ['https:']],
    ...COMMON_DOCUMENT_DIRECTIVES,
  ],
  /** 1.11: the isolated evaluator, the only document with 'unsafe-eval'. */
  'eval.html': (scriptHashes: readonly string[]): Policy => [
    ['sandbox', ['allow-scripts']],
    ['default-src', [NONE]],
    ['script-src', [...scriptHashes, UNSAFE_EVAL, WASM_UNSAFE_EVAL]],
    ['connect-src', [NONE]],
    ...COMMON_DOCUMENT_DIRECTIVES,
  ],
} as const satisfies Record<string, (scriptHashes: readonly string[]) => Policy>

export type SandboxDocument = keyof typeof SANDBOX_DOCUMENTS

export function isSandboxDocument(name: string): name is SandboxDocument {
  return Object.hasOwn(SANDBOX_DOCUMENTS, name)
}

/** What a landing-page document needs its policy to allow. */
export interface SitePageNeeds {
  scriptHashes: readonly string[]
  styleHashes: readonly string[]
  /** The page loads same-origin scripts (`<script src>`, `<link rel="modulepreload">`). */
  externalScripts: boolean
  /** The page loads same-origin stylesheets. */
  externalStyles: boolean
}

/**
 * A landing-page document's policy: its own inline scripts and styles by hash, its own
 * scripts, styles and images, and nothing else. The site has no third-party resources (its
 * build check refuses them, apps/site/README.md).
 */
export function sitePagePolicy(needs: SitePageNeeds): Policy {
  const scripts = unique([...(needs.externalScripts ? [SELF] : []), ...needs.scriptHashes])
  const styles = unique([...(needs.externalStyles ? [SELF] : []), ...needs.styleHashes])
  return [
    ['default-src', [NONE]],
    ...(scripts.length > 0 ? [['script-src', scripts] as const] : []),
    ...(styles.length > 0 ? [['style-src', styles] as const] : []),
    ['img-src', [SELF]],
    ['frame-ancestors', [NONE]],
    ...COMMON_DOCUMENT_DIRECTIVES,
  ]
}

/**
 * Everything else the site serves (stylesheets, icons, robots.txt, the sitemap, `.well-known`
 * files, the notices): the site's policy with nothing allowed. It matters only when a browser
 * opens such a file as a document, an SVG for example.
 */
export const STATIC_FILE_POLICY: Policy = [
  ['default-src', [NONE]],
  ['frame-ancestors', [NONE]],
  ...COMMON_DOCUMENT_DIRECTIVES,
]

/** What a rule path serves, for the checks below. */
export type RuleFamily = 'app' | 'embed' | 'sandbox' | 'evaluator' | 'site'

/** The family of a `_headers` rule path that make dist writes. */
export function ruleFamily(rulePath: string): RuleFamily {
  if (rulePath === '/app/*') return 'app'
  if (rulePath === '/embed/*') return 'embed'
  const sandbox = /^\/sandbox\/([^/]+?)(\.html)?$/.exec(rulePath)?.[1]
  if (sandbox !== undefined && isSandboxDocument(`${sandbox}.html`)) {
    return sandbox === 'eval' ? 'evaluator' : 'sandbox'
  }
  return 'site'
}

/**
 * Why a Content-Security-Policy breaks a promise FXM makes about the paths a rule serves (an
 * empty list when it doesn't): sandbox documents are opaque and only the evaluator may
 * evaluate, no page runs inline script it doesn't list by hash, and only the embed and the
 * sandbox documents may be framed by other sites. `make dist` checks every rule it writes,
 * and the header check every response.
 */
export function policyProblems(rulePath: string, value: string): string[] {
  let directives: Map<string, string[]>
  try {
    directives = parsePolicy(value)
  } catch (error) {
    return [(error as Error).message]
  }
  const family = ruleFamily(rulePath)
  const problems: string[] = []
  const sources = (name: string) => directives.get(name) ?? []
  const scripts = sources('script-src')
  if (family !== 'evaluator' && scripts.includes(UNSAFE_EVAL)) {
    problems.push(`${UNSAFE_EVAL} outside the evaluator document`)
  }
  if (scripts.includes(UNSAFE_INLINE)) problems.push(`script-src allows ${UNSAFE_INLINE}`)
  if (family === 'sandbox' || family === 'evaluator') {
    if (sources('sandbox').join(' ') !== 'allow-scripts') {
      problems.push('a sandbox document without "sandbox allow-scripts"')
    }
  }
  const framable = family === 'embed' || family === 'sandbox' || family === 'evaluator'
  if (!framable && sources('frame-ancestors').join(' ') !== NONE) {
    problems.push(`no "frame-ancestors ${NONE}"`)
  }
  if (framable && directives.has('frame-ancestors')) {
    problems.push('frame-ancestors, which would stop the embed or Lite inside other sites')
  }
  return problems
}

/**
 * The features the Permissions-Policy turns off: only ones FXM never uses. It turns off none
 * that a player may use ({@link PLAYER_FEATURES}).
 */
export const UNUSED_FEATURES = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'serial',
  'bluetooth',
  'hid',
  'midi',
] as const

/**
 * Features the player may use, which the Permissions-Policy must never turn off. The media keys
 * go through the Media Session API, which no policy controls.
 */
export const PLAYER_FEATURES: readonly string[] = [
  'autoplay',
  'fullscreen',
  'picture-in-picture',
  'screen-wake-lock',
]

/** `camera=(), microphone=(), …`: each unused feature allowed to no origin. */
export const PERMISSIONS_POLICY = UNUSED_FEATURES.map((feature) => `${feature}=()`).join(', ')

/**
 * Why a Permissions-Policy breaks FXM's promise (an empty list when it doesn't): it may only turn
 * off features FXM never uses, and never one the player may use.
 */
export function permissionsPolicyProblems(value: string): string[] {
  const problems: string[] = []
  for (const item of value.split(',')) {
    const feature = /^\s*([a-z-]+)=\(\s*\)\s*$/.exec(item)?.[1]
    if (feature === undefined) {
      problems.push(`"${item.trim()}" doesn't turn a feature off (feature=())`)
    } else if (PLAYER_FEATURES.includes(feature)) {
      problems.push(`it turns off ${feature}, which the player may use`)
    } else if (!(UNUSED_FEATURES as readonly string[]).includes(feature)) {
      problems.push(`it turns off ${feature}, which isn't one of the features FXM never uses`)
    }
  }
  return problems
}

/** Sent with every response, next to its policy (docs/PLAN.md, header rules). */
export const COMMON_HEADERS: readonly (readonly [name: string, value: string])[] = [
  // googlevideo requests from the page would otherwise carry Referer: https://fxmusic.pages.dev/
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  // A page opened at top level keeps no tie to a page of another site that opened it, or that it
  // opens: neither can reach the other's window. Browsers ignore it in frames, so the embed and
  // the sandbox documents work inside other pages as before; the embed counts on it when a page
  // opens a player in a new window (apps/web/src/embed/README.md).
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Permissions-Policy', PERMISSIONS_POLICY],
]
