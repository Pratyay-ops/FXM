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
  /**
   * connect-src for the web app only, never the embed: hosts the app reads bytes from that the
   * embed has no use for. 4.2: the image hosts whose covers go into saved files, each by its
   * exact name and only once measured to allow it (connect-src lets page script read what it
   * fetches, so it stays narrower than img-src).
   */
  readonly appConnect?: readonly string[]
}

/** YouTube's API hosts (InnerTube): the app with FXM Connect, and the Lite sandbox document. */
export const INNERTUBE_HOSTS = [
  'https://www.youtube.com',
  'https://music.youtube.com',
  'https://youtubei.googleapis.com',
] as const

/** Where YouTube's and YouTube Music's thumbnails, covers and channel images come from. */
const YOUTUBE_IMAGE_HOSTS = [
  'https://*.ytimg.com',
  'https://*.googleusercontent.com',
  'https://*.ggpht.com',
] as const

/** Where Spotify's covers and playlist images come from. */
const SPOTIFY_IMAGE_HOSTS = ['https://*.scdn.co', 'https://*.spotifycdn.com'] as const

/**
 * The hosts YouTube's and YouTube Music's track covers come from, whose bytes the app reads to
 * embed them in saved files (4.2). Each answers with `Access-Control-Allow-Origin: *`
 * (packages/sources/src/youtube/CLEAN-ROOM.md, 2026-10-26). A cover elsewhere is left out.
 */
const YOUTUBE_COVER_HOSTS = [
  'https://i.ytimg.com',
  'https://lh3.googleusercontent.com',
  'https://yt3.ggpht.com',
  'https://yt3.googleusercontent.com',
] as const

/**
 * Spotify's host for track covers, which answers with `Access-Control-Allow-Origin: *`
 * (packages/sources/src/spotify/README.md, 2026-10-26). Its `*.spotifycdn.com` hosts serve only
 * playlist and radio images, which no saved file needs.
 */
const SPOTIFY_COVER_HOSTS = ['https://i.scdn.co'] as const

/**
 * Every service the web app and the embed contact, in the order their hosts appear in the
 * policy. Only what shipped stages use (docs/PLAN.md, the notes on the `/app/*` rule). Stages
 * add theirs when they ship:
 *
 * - 1.11: the BotGuard hosts, once one of its rungs is on;
 * - 3.2's recommendation providers, once the app calls them: the hosts in the table in
 *   packages/sources/src/recommend/README.md. It leaves out the plan's `api.listenbrainz.org`
 *   and `lastfm.freetls.fastly.net`, which its providers don't contact (8.2's scrobbling, below,
 *   sends to `api.listenbrainz.org`), and adds Internet Archive's hosts, already here, for the
 *   Cover Art Archive's redirects.
 *
 * 4.2 lets the web app (not the embed) fetch the track covers it already shows from YouTube's
 * and Spotify's image hosts (`appConnect`: exact hosts, unlike img-src's wildcards), to embed
 * them in saved files; Internet Archive's and Jamendo's covers come from hosts it reaches
 * already. Those hosts send `Access-Control-Allow-Origin: *` (checked 2026-10-26).
 *
 * Audio needs no entry: `media-src https:` covers googlevideo, Internet Archive's and Jamendo's
 * storage hosts and a user's Invidious proxy, and page script can't read media responses.
 */
export const APP_SERVICES: readonly Service[] = [
  {
    privacyName: 'YouTube',
    connect: [...INNERTUBE_HOSTS, 'https://*.googlevideo.com'],
    img: YOUTUBE_IMAGE_HOSTS,
    appConnect: YOUTUBE_COVER_HOSTS,
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
    img: SPOTIFY_IMAGE_HOSTS,
    appConnect: SPOTIFY_COVER_HOSTS,
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
  // 8.2: scrobbling, once the user connects an account in Settings. Only the write APIs.
  { privacyName: 'ListenBrainz', connect: ['https://api.listenbrainz.org'] },
  { privacyName: 'Last.fm', connect: ['https://ws.audioscrobbler.com'] },
  // 8.4: library sync, only once the user turns it on, with a secret gist on their account.
  { privacyName: 'GitHub', connect: ['https://api.github.com'] },
]

/**
 * Extra script-src sources for the web app, not the embed. 4.2's WASM_UNSAFE_EVAL lets the
 * conversion worker compile FXM's ffmpeg core (WebAssembly); the embed converts nothing. Never
 * UNSAFE_EVAL or UNSAFE_INLINE: appPolicy() refuses them.
 */
export const APP_SCRIPT_EXTRAS: readonly string[] = [WASM_UNSAFE_EVAL]

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
    for (const host of [
      ...(service.connect ?? []),
      ...(service.img ?? []),
      ...(service.appConnect ?? []),
    ]) {
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
 * `frame-ancestors`, because any site may embed the player, and without what only the app
 * needs (`scriptExtras`, `appConnect`): the embed converts and saves nothing.
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
  const app = !options.embeddable
  const connect = unique(
    services.flatMap((service) => [
      ...(service.connect ?? []),
      ...(app ? (service.appConnect ?? []) : []),
    ]),
  )
  const img = unique(services.flatMap((service) => service.img ?? []))
  return [
    ['default-src', [SELF]],
    ['script-src', unique([SELF, ...scriptHashes, ...(app ? extras : [])])],
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

/** Sent with every response, next to its policy (docs/PLAN.md, header rules). */
export const COMMON_HEADERS: readonly (readonly [name: string, value: string])[] = [
  // googlevideo requests from the page would otherwise carry Referer: https://fxmusic.pages.dev/
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
]
