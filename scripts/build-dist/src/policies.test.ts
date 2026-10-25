import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parsePolicy, serializePolicy, sha256Source, UNSAFE_EVAL, WASM_UNSAFE_EVAL } from './csp.ts'
import {
  APP_SCRIPT_EXTRAS,
  APP_SERVICES,
  appPolicy,
  isSandboxDocument,
  SANDBOX_DOCUMENTS,
  STATIC_FILE_POLICY,
  sitePagePolicy,
} from './policies.ts'
import { isHostSource } from './privacy.ts'

const HASH = sha256Source('theme()')

/** The `/app/*` policy exactly as docs/PLAN.md (stage 2.8) prints it, with a real hash. */
const PLAN_APP_POLICY =
  "default-src 'self'; script-src 'self' 'sha256-…'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'".replace(
    "'sha256-…'",
    HASH,
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

describe('the web app policy', () => {
  it('is the policy docs/PLAN.md specifies for /app/*', () => {
    expect(serializePolicy(appPolicy([HASH]))).toBe(PLAN_APP_POLICY)
  })

  it('stays under the 850-character estimate at M1, far below 2,000', () => {
    expect(serializePolicy(appPolicy([HASH])).length).toBeLessThan(900)
  })

  it('drops only frame-ancestors for the embed', () => {
    const embed = serializePolicy(appPolicy([HASH], { embeddable: true }))
    expect(embed).toBe(PLAN_APP_POLICY.replace(" frame-ancestors 'none';", ''))
  })

  it('takes later stages’ hosts and script sources from the lists', () => {
    const policy = parsePolicy(
      serializePolicy(
        appPolicy([HASH], {
          services: [
            ...APP_SERVICES,
            { privacyName: 'SponsorBlock', connect: ['https://sponsor.ajay.app'] },
          ],
          scriptExtras: [WASM_UNSAFE_EVAL],
        }),
      ),
    )
    expect(policy.get('connect-src')?.at(-1)).toBe('https://sponsor.ajay.app')
    expect(policy.get('script-src')).toEqual(["'self'", HASH, WASM_UNSAFE_EVAL])
  })

  it("never allows 'unsafe-eval' or 'unsafe-inline' scripts", () => {
    expect(() => appPolicy([HASH], { scriptExtras: [UNSAFE_EVAL] })).toThrow(/never/)
    expect(() => appPolicy([HASH], { scriptExtras: ["'unsafe-inline'"] })).toThrow(/never/)
    expect(APP_SCRIPT_EXTRAS).not.toContain(UNSAFE_EVAL)
  })

  it('names only HTTPS hosts, each under the service the privacy page lists', () => {
    for (const service of APP_SERVICES) {
      expect(service.privacyName).toMatch(/\S/)
      for (const host of [...(service.connect ?? []), ...(service.img ?? [])]) {
        expect(host).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+$/)
        expect(isHostSource(host)).toBe(true)
      }
    }
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
      'eval.html': `sandbox allow-scripts; default-src 'none'; script-src ${HASH} 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; base-uri 'none'; form-action 'none'`,
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
