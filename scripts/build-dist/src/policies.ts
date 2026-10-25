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
 * - 1.11: the BotGuard hosts, once one of its rungs is on;
 * - 3.2: Last.fm (`www.last.fm`, `ws.audioscrobbler.com`, `lastfm.freetls.fastly.net`),
 *   ListenBrainz (`api.listenbrainz.org`, `labs.api.listenbrainz.org`), Cover Art Archive
 *   (`coverartarchive.org`) and iTunes Search (`itunes.apple.com`, `*.mzstatic.com`);
 * - 8.7: SponsorBlock (`sponsor.ajay.app`).
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
]

/**
 * Extra script-src sources for the web app and the embed. 4.2 adds WASM_UNSAFE_EVAL here for
 * ffmpeg.wasm in its worker. Never UNSAFE_EVAL or UNSAFE_INLINE: appPolicy() refuses them.
 */
export const APP_SCRIPT_EXTRAS: readonly string[] = []

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

/** Sent with every response, next to its policy (docs/PLAN.md, header rules). */
export const COMMON_HEADERS: readonly (readonly [name: string, value: string])[] = [
  // googlevideo requests from the page would otherwise carry Referer: https://fxm-music.pages.dev/
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
]
