/**
 * Rung selection with the experimental rungs: which rungs the ladder tries where, and what each
 * returns, through the real resolver of `../resolver.ts` with the hook of `rungs.ts`, the real
 * evaluator runtime (in process) and the recorded `/player` answers.
 */

import {
  DEFAULT_QUALITY_PREFS,
  type NetworkCapabilities,
  type Platform,
  type QualityPrefs,
} from '@fxm/core'
import {
  createEvaluator,
  createInProcessEvaluator,
  FAKE_BOTGUARD_GLOBAL,
  fakeWebPoToken,
} from '@fxm/platform/testing/evaluator'
import { afterEach, describe, expect, it } from 'vitest'
import {
  context,
  FULL,
  fakeInnerTube,
  onSwJsData,
  type Route,
  SIMPLE,
} from '../../fixtures/testing'
import { createYouTubeSession } from '../../session'
import { BUNDLED_STREAM_CONFIG, type StreamConfig } from '../config'
import {
  CAP_BYTES,
  candidate,
  clientOf,
  fakeGoogleVideo,
  isGoogleVideo,
  onPlayer,
  PLAYER_FIXTURES,
  VIDEOS,
} from '../fixtures/testing'
import { createYouTubeAudioSource } from '../resolver'
import { GENERATE_IT_URL } from './botguard'
import type { StreamEvaluator } from './evaluator'
import { FAKE_SIGNATURE } from './fixtures/sanitize'
import {
  ADVANCED_FIXTURES,
  botGuardRoutes,
  decipheredSignature,
  FAKE_INTEGRITY_KEY,
  FAKE_PLAYER_ID,
  FAKE_SIGNATURE_TIMESTAMP,
  fakeExtractor,
  onIframeApi,
  onPlayerScript,
  transformedN,
} from './fixtures/testing'
import { type AdvancedRungsOptions, createAdvancedRungs, EVALUATOR_RETRY_MS } from './rungs'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE_BOTGUARD_GLOBAL]
  delete (globalThis as Record<string, unknown>).yt
})

const PREFS = DEFAULT_QUALITY_PREFS as QualityPrefs
const SONG = candidate(VIDEOS.song)
const YOUTUBE = 'https://www.youtube.com'
const TOKEN = fakeWebPoToken(FAKE_INTEGRITY_KEY, VIDEOS.song)
const TV_AGENT = BUNDLED_STREAM_CONFIG.rungs.find((rung) => rung.id === 'tv-samsung')?.client.fields
  .userAgent

/** The bundled config with the given rungs switched on and VISIONOS off. */
function only(...on: string[]): StreamConfig {
  return {
    ...BUNDLED_STREAM_CONFIG,
    rungs: BUNDLED_STREAM_CONFIG.rungs.map((rung) => ({
      ...rung,
      enabled: on.includes(rung.id),
    })),
  }
}

const ON = {
  tv: onPlayer('TVHTML5', VIDEOS.song, ADVANCED_FIXTURES['tv-samsung-song']),
  tvReload: onPlayer('TVHTML5', VIDEOS.song, ADVANCED_FIXTURES['tv-samsung-reload']),
  mweb: onPlayer('MWEB', VIDEOS.song, ADVANCED_FIXTURES['mweb-song']),
  remix: onPlayer('WEB_REMIX', VIDEOS.song, ADVANCED_FIXTURES['web-remix-song']),
  sabr: onPlayer('WEB', VIDEOS.song, ADVANCED_FIXTURES['web-sabr-song']),
  android: onPlayer('ANDROID', VIDEOS.song, PLAYER_FIXTURES['android-song']),
  visionos: onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']),
}

/** googlevideo as the attested clients' URLs behave: capped unless `pot` is the video's token. */
const attestedGoogleVideo = fakeGoogleVideo({
  answer({ url, last }) {
    const client = url.searchParams.get('c') ?? ''
    const attested = client === 'MWEB' || client === 'WEB_REMIX'
    if (attested && last >= CAP_BYTES && url.searchParams.get('pot') !== TOKEN) {
      return new Response(null, { status: 403 })
    }
    return undefined
  },
})

interface Setup {
  config: StreamConfig
  routes?: Route[]
  capabilities?: NetworkCapabilities
  platform?: Platform
  origin?: string | null
  /** An evaluator of the test's own instead of the in-process one. */
  evaluator?: StreamEvaluator
  advanced?: Omit<AdvancedRungsOptions, 'evaluator' | 'extractPlayerScript'>
  extract?: ReturnType<typeof fakeExtractor>
  /** Whether GenerateIT refuses the attestation. */
  refuse?: boolean
}

/** An evaluator whose document never starts, at YouTube's origin, counting its starts. */
function neverStarting(openTimeoutMs: number) {
  let starts = 0
  const evaluator = createEvaluator(
    'android',
    {
      open() {
        starts += 1
        return new Promise(() => {})
      },
      send: () => new Promise(() => {}),
      close() {},
    },
    { origin: YOUTUBE, openTimeoutMs },
  )
  return {
    evaluator,
    get starts() {
      return starts
    },
  }
}

function setup(setupOptions: Setup) {
  const { fetch, requests } = fakeInnerTube(
    onSwJsData(),
    onIframeApi(),
    onPlayerScript(),
    ...botGuardRoutes({ refuse: setupOptions.refuse === true }),
    ...(setupOptions.routes ?? []),
    attestedGoogleVideo,
  )
  const inProcess =
    setupOptions.evaluator !== undefined || setupOptions.origin === null
      ? undefined
      : createInProcessEvaluator({ origin: setupOptions.origin ?? YOUTUBE })
  const evaluator = setupOptions.evaluator ?? inProcess
  const extractor = setupOptions.extract ?? fakeExtractor()
  const advanced = createAdvancedRungs({
    ...(evaluator === undefined ? {} : { evaluator }),
    extractPlayerScript: extractor.extract,
    ...setupOptions.advanced,
  })
  const audio = createYouTubeAudioSource({
    session: createYouTubeSession(),
    streamConfig: setupOptions.config,
    advanced,
  })
  const ctx = {
    ...context(fetch, { capabilities: setupOptions.capabilities ?? FULL, mode: 'music' }),
    platform: setupOptions.platform ?? 'desktop',
  }
  return {
    audio,
    advanced,
    ctx,
    requests,
    evaluator: inProcess,
    players: () =>
      requests.filter((request) => request.url.pathname === '/youtubei/v1/player').map(clientOf),
    probes: () => requests.filter(isGoogleVideo),
    paths: () => requests.map((request) => request.url.pathname),
  }
}

describe('the experimental rungs', () => {
  it('ship off: the bundled ladder never fetches a player script or asks BotGuard', async () => {
    const { audio, ctx, players, paths } = setup({
      config: BUNDLED_STREAM_CONFIG,
      routes: [ON.visionos],
    })
    const options = await audio.resolve(SONG, ctx, PREFS)
    expect(options[0]?.rung).toBe('visionos')
    expect(players()).toEqual(['VISIONOS'])
    expect(paths()).not.toContain('/iframe_api')
    expect(paths()).not.toContain('/api/jnn/v1/GenerateIT')
  })

  describe('which rungs each platform tries', () => {
    const all = only('tv-samsung', 'mweb', 'web-remix', 'web-sabr', 'android-muxed')
    const supported = (setupOptions: Omit<Setup, 'config'>) => {
      const { advanced, ctx } = setup({ config: all, ...setupOptions })
      const context = { ...ctx, platform: setupOptions.platform ?? ctx.platform }
      return all.rungs
        .filter((rung) => rung.kind !== 'direct' && advanced.canRun(rung, context))
        .map((rung) => rung.id)
    }

    it('none without an evaluator, or in the Lite tier', () => {
      expect(supported({ origin: null })).toEqual([])
      expect(supported({ capabilities: SIMPLE })).toEqual([])
    })

    it('the attested and SABR rungs only with an evaluator at YouTube’s origin', () => {
      expect(supported({ origin: 'fxm-eval://localhost' })).toEqual([])
      expect(supported({ origin: YOUTUBE })).toEqual(['mweb', 'web-remix', 'web-sabr'])
    })

    it('SABR not on Android, which has no MediaSource engine, nor without media bytes', () => {
      expect(supported({ platform: 'android' })).toEqual(['mweb', 'web-remix'])
    })

    it('the TV rung only where a request can set its User-Agent', () => {
      expect(supported({ advanced: { sendsUserAgent: true } })).toContain('tv-samsung')
      expect(
        supported({ origin: 'fxm-eval://localhost', advanced: { sendsUserAgent: true } }),
      ).toEqual(['tv-samsung'])
    })

    it('decides without starting the evaluator, so VISIONOS never waits for it', async () => {
      const never = neverStarting(60_000)
      const { audio, ctx, players } = setup({
        config: only('visionos', 'mweb', 'web-remix', 'android-muxed'),
        routes: [ON.visionos],
        evaluator: never.evaluator,
      })
      const started = Date.now()
      const [option] = await audio.resolve(SONG, ctx, PREFS)
      expect(option?.rung).toBe('visionos')
      expect(players()).toEqual(['VISIONOS'])
      expect(never.starts).toBe(0)
      expect(Date.now() - started).toBeLessThan(5_000)
    })

    it('leaves an evaluator that could not start alone for a while', async () => {
      const never = neverStarting(20)
      let time = Date.UTC(2026, 9, 26, 12)
      const { audio, advanced, ctx, players } = setup({
        config: only('mweb', 'android-muxed'),
        routes: [ON.mweb, ON.android],
        evaluator: never.evaluator,
        advanced: { now: () => time },
      })
      const mweb = BUNDLED_STREAM_CONFIG.rungs.find((rung) => rung.id === 'mweb')
      if (mweb === undefined) throw new Error('no mweb rung')
      expect(advanced.canRun(mweb, ctx)).toBe(true)
      const [muxed] = await audio.resolve(SONG, ctx, PREFS)
      expect(muxed?.rung).toBe('android-muxed')
      expect(players()).toEqual(['MWEB', 'ANDROID'])
      expect(never.starts).toBe(1)
      // No rung that needs the evaluator is tried, or waits for it, until the retry time.
      expect(advanced.canRun(mweb, ctx)).toBe(false)
      await audio.resolve(SONG, ctx, PREFS)
      expect(never.starts).toBe(1)
      time += EVALUATOR_RETRY_MS
      expect(advanced.canRun(mweb, ctx)).toBe(true)
    })

    it('skips enabled rungs it cannot try, without a request for them', async () => {
      const { audio, ctx, players, paths } = setup({
        config: all,
        origin: 'fxm-eval://localhost',
        routes: [ON.android],
      })
      const [muxed] = await audio.resolve(SONG, ctx, PREFS)
      expect(muxed?.rung).toBe('android-muxed')
      expect(players()).toEqual(['ANDROID'])
      expect(paths()).not.toContain('/iframe_api')
    })
  })

  describe('the deciphered rung (tv-samsung)', () => {
    it('sends the signatureTimestamp and its user agent, and deciphers its URLs', async () => {
      const { audio, ctx, requests, probes } = setup({
        config: only('tv-samsung', 'android-muxed'),
        routes: [ON.tv],
        advanced: { sendsUserAgent: true },
      })
      const options = await audio.resolve(SONG, ctx, PREFS)
      expect(options.map((option) => [option.rung, option.itag, option.fullLength])).toEqual([
        ['tv-samsung', 251, 'verified'],
        ['tv-samsung', 140, 'verified'],
        ['tv-samsung', 250, 'verified'],
        ['tv-samsung', 249, 'verified'],
      ])
      const player = requests.find((request) => request.url.pathname === '/youtubei/v1/player')
      expect(player?.body.playbackContext).toEqual({
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
          signatureTimestamp: FAKE_SIGNATURE_TIMESTAMP,
        },
      })
      expect(player?.headers.get('user-agent')).toBe(TV_AGENT)
      expect(player?.body.context).toMatchObject({
        client: { clientName: 'TVHTML5', deviceMake: 'Samsung', osName: 'Tizen' },
      })
      const opus = new URL(options[0]?.url ?? '')
      expect(opus.searchParams.get('sig')).toBe(decipheredSignature(FAKE_SIGNATURE))
      expect(opus.searchParams.get('n')).toBe(transformedN('fxm-n-251'))
      expect(probes()).toHaveLength(4)
    })

    it('moves on when YouTube answers its call "The page needs to be reloaded"', async () => {
      const { audio, ctx, players } = setup({
        config: only('tv-samsung', 'android-muxed'),
        routes: [ON.tvReload, ON.android],
        advanced: { sendsUserAgent: true },
      })
      const [muxed] = await audio.resolve(SONG, ctx, PREFS)
      expect(muxed?.rung).toBe('android-muxed')
      expect(players()).toEqual(['TVHTML5', 'ANDROID'])
    })

    it('keeps the player script after a deciphering that timed out, and checks its ID after one that failed', async () => {
      const inner = createInProcessEvaluator({ origin: YOUTUBE })
      const failures = [
        Object.assign(new Error('The evaluator did not answer invoke in time'), {
          evaluatorCode: 'timeout',
        }),
        Object.assign(new Error('TypeError: the player changed'), {
          evaluatorCode: 'script-error',
        }),
      ]
      const evaluator: StreamEvaluator = {
        origin: inner.origin,
        ready: (callOptions) => inner.ready(callOptions),
        evaluate: (source, args, callOptions) => {
          const failure = failures.shift()
          return failure === undefined
            ? inner.evaluate(source, args, callOptions)
            : Promise.reject(failure)
        },
        botguardSnapshot: (challenge, callOptions) =>
          inner.botguardSnapshot(challenge, callOptions),
        mintWebPoTokens: (token, bindings, callOptions) =>
          inner.mintWebPoTokens(token, bindings, callOptions),
      }
      const extract = fakeExtractor()
      const { audio, ctx, paths } = setup({
        config: only('tv-samsung'),
        routes: [ON.tv],
        advanced: { sendsUserAgent: true },
        evaluator,
        extract,
      })
      for (let failed = 0; failed < 2; failed += 1) {
        await expect(audio.resolve(SONG, ctx, PREFS)).rejects.toThrow('The tv-samsung rung failed')
      }
      const [option] = await audio.resolve(SONG, ctx, PREFS)
      expect(option?.rung).toBe('tv-samsung')
      // One extract in all; the ID was checked again once, after the script failed.
      expect(extract.extracted).toEqual([FAKE_PLAYER_ID])
      expect(paths().filter((path) => path === '/iframe_api')).toHaveLength(2)
    })

    it('counts a player script it cannot read against the rung and moves on', async () => {
      const broken = fakeExtractor({ signatureTimestamp: 0 })
      const { audio, ctx, players } = setup({
        config: only('tv-samsung', 'android-muxed'),
        routes: [ON.android],
        advanced: { sendsUserAgent: true },
        extract: broken,
      })
      const [muxed] = await audio.resolve(SONG, ctx, PREFS)
      expect(muxed?.rung).toBe('android-muxed')
      expect(players()).toEqual(['ANDROID'])
      const health = await audio.health(ctx)
      expect(health.rungs.find((rung) => rung.rung === 'tv-samsung')).toMatchObject({
        lastFailure: 'error',
      })
    })
  })

  describe('the attested rungs (mweb, web-remix)', () => {
    it('add a web PO token bound to the video, which makes their URLs whole', async () => {
      const { audio, ctx, requests, evaluator } = setup({
        config: only('mweb', 'android-muxed'),
        routes: [ON.mweb],
      })
      const options = await audio.resolve(SONG, ctx, PREFS)
      expect(options[0]).toMatchObject({ rung: 'mweb', itag: 251, fullLength: 'verified' })
      expect(new URL(options[0]?.url ?? '').searchParams.get('pot')).toBe(TOKEN)
      expect(requests.filter((request) => request.url.href === GENERATE_IT_URL)).toHaveLength(1)
      expect(evaluator?.requests.map((request) => request.method)).toEqual([
        'define',
        'invoke',
        'botguard.snapshot',
        'botguard.mint',
      ])
    })

    it('fall back to itag 18 when BotGuard refuses the attestation', async () => {
      const { audio, ctx, players } = setup({
        config: only('web-remix', 'android-muxed'),
        routes: [ON.remix, ON.android],
        refuse: true,
      })
      const [muxed] = await audio.resolve(SONG, ctx, PREFS)
      expect(muxed?.rung).toBe('android-muxed')
      expect(players()).toEqual(['WEB_REMIX', 'ANDROID'])
    })
  })

  describe('the SABR rung (web-sabr)', () => {
    it('returns SABR sessions with a token, which are not probed', async () => {
      const { audio, ctx, probes } = setup({ config: only('web-sabr'), routes: [ON.sabr] })
      const options = await audio.resolve(SONG, ctx, PREFS)
      expect(options.map((option) => [option.itag, option.protocol, option.fullLength])).toEqual([
        [251, 'sabr', 'unverified'],
        [140, 'sabr', 'unverified'],
      ])
      expect(new URL(options[0]?.url ?? '').searchParams.get('n')).toBe(transformedN('fxm-n-sabr'))
      expect(options[0]?.playback).toMatchObject({ poToken: TOKEN, client: { nameId: 1 } })
      expect(probes()).toHaveLength(0)
    })
  })
})
