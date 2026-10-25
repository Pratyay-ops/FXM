/**
 * Test helpers for the experimental rungs: the recorded `/player` answers next to this file, and
 * stand-ins for everything else they fetch. No code of YouTube's or Google's is involved:
 *
 * - the player script is a made-up extract whose "signature function" reverses the signature
 *   and whose "n function" reverses `n` behind an `fxm-` prefix ({@link decipheredSignature},
 *   {@link transformedN});
 * - the home page is a minimal page with an `EVENT_ID` and an attestation challenge for the fake
 *   BotGuard of `@fxm/platform/testing`;
 * - `GenerateIT` answers a fake integrity token.
 *
 * The `/player` fixtures are real answers recorded on 2026-10-26 from Node on a residential
 * connection, sanitized by `sanitize.ts`.
 *
 * @module
 */

import {
  FAKE_BOTGUARD_GLOBAL,
  fakeBotGuardInterpreter,
  fakeIntegrityToken,
} from '@fxm/platform/testing/evaluator'
import { json, type Route } from '../../../fixtures/testing'
import { GENERATE_IT_URL, YOUTUBE_HOME_URL } from '../botguard'
import { IFRAME_API_URL, PLAYER_SCRIPT_PREFIX, type PlayerScriptExtractor } from '../player-script'
import mwebSong from './mweb-song.json'
import tvSamsungReload from './tv-samsung-reload.json'
import tvSamsungSong from './tv-samsung-song.json'
import webRemixSong from './web-remix-song.json'
import webSabrSong from './web-sabr-song.json'

/** The recorded `/player` answers, by file name without `.json`. */
export const ADVANCED_FIXTURES = {
  'mweb-song': mwebSong,
  'tv-samsung-reload': tvSamsungReload,
  'tv-samsung-song': tvSamsungSong,
  'web-remix-song': webRemixSong,
  'web-sabr-song': webSabrSong,
} as const

/** The player the fake `/iframe_api` names. */
export const FAKE_PLAYER_ID = 'f0f0f0f0'

/** The fake player's `signatureTimestamp`. */
export const FAKE_SIGNATURE_TIMESTAMP = 20746

/** The `EVENT_ID` of the fake home page. */
export const FAKE_EVENT_ID = 'fxmEventId0123'

/** Where the fake home page's challenge puts BotGuard's interpreter. */
export const FAKE_INTERPRETER_URL = 'https://www.google.com/js/th/fxm-fake-interpreter.js'

/** The program of the fake challenge. */
export const FAKE_PROGRAM = 'fxm-fake-program'

/** The key of the fake integrity token (see `fakeIntegrityToken` of `@fxm/platform/testing`). */
export const FAKE_INTEGRITY_KEY = 'fxm-integrity'

/** What the fake player's signature function makes of a scrambled signature. */
export function decipheredSignature(s: string): string {
  return [...s].reverse().join('')
}

/** What the fake player's n function makes of `n`. */
export function transformedN(n: string): string {
  return `fxm-${[...n].reverse().join('')}`
}

/** The fake extract, in the shape youtubei.js gives (`exportedVars.nsigFunction`). */
export function fakePlayerScript(options: { brokenN?: boolean } = {}): string {
  const n =
    options.brokenN === true ? "'enhanced_except_fxm'" : "'fxm-' + [...n].reverse().join('')"
  return `const exportedVars = (function () {
  class FakeUrl {
    constructor(url, sp, s) {
      this.params = new URL(url).searchParams
      this.sp = sp
      this.s = s
    }
    applySignature() {
      if (this.s) this.params.set(this.sp, [...this.s].reverse().join(''))
    }
    applyN() {
      const n = this.params.get('n')
      if (n) this.params.set('n', ${n})
    }
    get(name) {
      return this.params.get(name)
    }
    set(name, value) {
      this.params.set(name, value)
    }
  }
  return { nsigFunction: (url, sp, s) => new FakeUrl(url, sp, s) }
})()`
}

/** A fake extractor that fetches the script like youtubei.js does, and returns {@link fakePlayerScript}. */
export function fakeExtractor(options: { brokenN?: boolean; signatureTimestamp?: number } = {}) {
  const extracted: string[] = []
  const extract: PlayerScriptExtractor = async (playerId, fetchScript) => {
    const response = await fetchScript(
      `${PLAYER_SCRIPT_PREFIX}${playerId}/player_es6.vflset/en_US/base.js`,
    )
    if (!response.ok) throw new Error(`base.js: HTTP ${response.status}`)
    extracted.push(playerId)
    return {
      signatureTimestamp: options.signatureTimestamp ?? FAKE_SIGNATURE_TIMESTAMP,
      script: fakePlayerScript(options),
    }
  }
  return { extract, extracted }
}

/** The text of `/iframe_api` naming `playerId`, with the escaped slashes of the real one. */
export function iframeApi(playerId = FAKE_PLAYER_ID): string {
  return `var scriptUrl = 'https:\\/\\/www.youtube.com\\/s\\/player\\/${playerId}\\/www-widgetapi.vflset\\/www-widgetapi.js';try{var ttPolicy=window.trustedTypes}catch(e){}`
}

/** JSON written the way YouTube's page writes the challenge: single quotes, `\x` escapes. */
function looseString(value: unknown): string {
  return JSON.stringify(value).replace(
    /["{}]/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16)}`,
  )
}

/** A minimal home page with an `EVENT_ID` and a challenge for the fake BotGuard. */
export function homePage(
  options: { eventId?: string; interpreterUrl?: string; program?: string } = {},
): string {
  const interpreter = new URL(options.interpreterUrl ?? FAKE_INTERPRETER_URL)
  const response = {
    responseContext: {},
    bgChallenge: {
      interpreterUrl: {
        privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: `//${interpreter.host}${interpreter.pathname}`,
      },
      program: options.program ?? FAKE_PROGRAM,
      globalName: FAKE_BOTGUARD_GLOBAL,
    },
  }
  const config = { EVENT_ID: options.eventId ?? FAKE_EVENT_ID, INNERTUBE_CLIENT_NAME: 'WEB' }
  return `<!DOCTYPE html><html><head><script>ytcfg.set(${JSON.stringify(config)});</script></head><body><script>window.ytAtN({'R': '${looseString(response)}'});</script></body></html>`
}

/** A route that answers `/iframe_api` naming `playerId`. */
export function onIframeApi(playerId = FAKE_PLAYER_ID): Route {
  return (request) =>
    request.url.href === IFRAME_API_URL ? new Response(iframeApi(playerId)) : undefined
}

/** A route that answers any player script request. */
export function onPlayerScript(): Route {
  return (request) =>
    request.url.href.startsWith(PLAYER_SCRIPT_PREFIX)
      ? new Response('/* base.js stands in for the real one */')
      : undefined
}

/** A route that answers the home page. */
export function onHomePage(page = homePage()): Route {
  return (request) => (request.url.href === YOUTUBE_HOME_URL ? new Response(page) : undefined)
}

/** A route that answers the fake interpreter. */
export function onInterpreter(url = FAKE_INTERPRETER_URL): Route {
  return (request) =>
    request.url.href === url ? new Response(fakeBotGuardInterpreter()) : undefined
}

/**
 * A route that answers `GenerateIT` with the fake integrity token, or, with `refuse`, the way it
 * answers a refused attestation: no token, only a fallback.
 */
export function onGenerateIt(options: { refuse?: boolean } = {}): Route {
  return (request) => {
    if (request.url.href !== GENERATE_IT_URL || request.method !== 'POST') return undefined
    return options.refuse === true
      ? json([null, 43200, null, 'fxmFallbackToken'])
      : json([fakeIntegrityToken(FAKE_INTEGRITY_KEY), 43200, 100])
  }
}

/** Every route the BotGuard session needs. */
export function botGuardRoutes(options: { refuse?: boolean } = {}): Route[] {
  return [onHomePage(), onInterpreter(), onGenerateIt(options)]
}
