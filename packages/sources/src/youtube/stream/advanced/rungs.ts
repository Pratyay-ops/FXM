/**
 * The experimental rungs of the YouTube ladder (stage 1.11), all shipped off in
 * `youtube-config.json`, between VISIONOS and itag 18:
 *
 * | Kind | Rung | What it does |
 * |---|---|---|
 * | `deciphered` | `tv-samsung` | A tv_samsung-style TVHTML5 client (device make and model, OS fields, the player's `signatureTimestamp`); its ciphered URLs are deciphered in the isolated evaluator |
 * | `attested` | `mweb`, `web-remix` | The same, plus a web PO token from BotGuard in the evaluator as each URL's `pot` |
 * | `sabr` | `web-sabr` | The web client over SABR: one session per audio format, for `@fxm/player`'s MediaSource engine, with a web PO token |
 *
 * `createAdvancedRungs()` is the resolver's hook for them (`hook.ts`); pass it to
 * `createYouTubeAudioSource({ advanced })`. What each rung needs, and the live results, are in
 * this folder's `README.md`.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { arrayAt, asNumber, asRecord, asString, at, type JsonRecord } from '../../json'
import type { StreamRungConfig } from '../config'
import { streamOptionsOf } from '../formats'
import { WebPoTokens } from './botguard'
import { cipheredUrlOf, decipherUrls } from './decipher'
import { ATTESTATION_ORIGIN, type StreamEvaluator } from './evaluator'
import type { AdvancedPlayerCall, AdvancedRungs } from './hook'
import { type PlayerScriptExtractor, type PlayerScriptStore, PlayerScripts } from './player-script'
import { sabrStreamOptions } from './sabr'

/** Options for {@link createAdvancedRungs}. */
export interface AdvancedRungsOptions {
  /**
   * The isolated evaluator of `@fxm/platform` for this platform. Without one, no experimental
   * rung is tried.
   */
  evaluator?: StreamEvaluator
  /**
   * Whether `ctx.fetch` sends a `User-Agent` header that a request sets. The `tv-samsung` rung
   * needs its TV's user agent on the request (measured 2026-10-26), and FXM's transports send a
   * browser's instead: the web can't change it, and the desktop and Android transports replace
   * it on InnerTube calls. So the rung is tried only where this is true, such as Node.
   */
  sendsUserAgent?: boolean
  /** Where to keep the extracted player script between sessions. */
  playerScriptStore?: PlayerScriptStore
  /** How long a player's ID is trusted before it is checked again; 6 hours by default. */
  playerScriptMaxAgeMs?: number
  /** How long one request may take, in milliseconds; 30 s by default. */
  timeoutMs?: number
  /** The clock, for tests. */
  now?: () => number
  /** Extracts the player script's functions; youtubei.js by default. For tests. */
  extractPlayerScript?: PlayerScriptExtractor
}

/** The experimental rungs, with their caches for diagnostics and tests. */
export interface AdvancedRungsHook extends AdvancedRungs {
  /** The player script cache. */
  readonly playerScripts: PlayerScripts
  /** The web PO tokens, when there is an evaluator. */
  readonly poTokens: WebPoTokens | undefined
}

/** The audio formats of an answer, plain objects only. */
function formatsOf(response: JsonRecord): JsonRecord[] {
  return [
    ...arrayAt(response, 'streamingData', 'formats'),
    ...arrayAt(response, 'streamingData', 'adaptiveFormats'),
  ].flatMap((value) => {
    const format = asRecord(value)
    return format === undefined ? [] : [format]
  })
}

/** `url` with `name` set to `value`. */
function withParam(url: string, name: string, value: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set(name, value)
  return parsed.href
}

/** Creates the hook for the experimental rungs. */
export function createAdvancedRungs(options: AdvancedRungsOptions = {}): AdvancedRungsHook {
  const { evaluator } = options
  const now = options.now ?? Date.now
  const playerScripts = new PlayerScripts({
    ...(options.playerScriptStore === undefined ? {} : { store: options.playerScriptStore }),
    ...(options.playerScriptMaxAgeMs === undefined
      ? {}
      : { maxAgeMs: options.playerScriptMaxAgeMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.extractPlayerScript === undefined ? {} : { extract: options.extractPlayerScript }),
    now,
  })
  const poTokens =
    evaluator === undefined
      ? undefined
      : new WebPoTokens({
          evaluator,
          now,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })

  function required(): { evaluator: StreamEvaluator; poTokens: WebPoTokens } {
    if (evaluator === undefined || poTokens === undefined) {
      throw new FxmError(
        'Unsupported',
        'The experimental YouTube rungs need the isolated evaluator',
      )
    }
    return { evaluator, poTokens }
  }

  /** The evaluator's document origin, or `undefined` when it does not start. */
  async function evaluatorOrigin(ctx: ProviderContext): Promise<string | undefined> {
    try {
      return (await evaluator?.ready(ctx.signal ? { signal: ctx.signal } : {}))?.origin
    } catch {
      return undefined
    }
  }

  /**
   * The answer with its formats of the rung's itags deciphered, each URL with a web PO token as
   * `pot` when `tokenFor` gives one (minted after deciphering succeeded).
   */
  async function decipheredResponse(
    ctx: ProviderContext,
    rung: StreamRungConfig,
    response: JsonRecord,
    tokenFor?: () => Promise<string>,
  ): Promise<JsonRecord> {
    const tools = required()
    const player = await playerScripts.current(ctx)
    const wanted = new Set(rung.itags)
    const picked = formatsOf(response).filter((format) => {
      const itag = asNumber(format.itag)
      return itag !== undefined && wanted.has(itag)
    })
    const ciphered = picked.flatMap((format) => {
      const entry = cipheredUrlOf(format)
      return entry === undefined ? [] : [{ format, entry }]
    })
    let urls: string[]
    try {
      urls = await decipherUrls(
        tools.evaluator,
        player,
        ciphered.map(({ entry }) => entry),
        ctx.signal ? { signal: ctx.signal } : {},
      )
    } catch (error) {
      // A new player may have changed its functions: read it again next time.
      playerScripts.invalidate()
      throw error
    }
    const token = ciphered.length === 0 ? undefined : await tokenFor?.()
    const replaced = new Map<JsonRecord, string>()
    ciphered.forEach(({ format }, index) => {
      const url = urls[index]
      if (url !== undefined)
        replaced.set(format, token === undefined ? url : withParam(url, 'pot', token))
    })
    const rewrite = (list: unknown): unknown[] =>
      (Array.isArray(list) ? list : []).map((value) => {
        const format = asRecord(value)
        const url = format === undefined ? undefined : replaced.get(format)
        if (format === undefined || url === undefined) return value
        const { signatureCipher: _signature, cipher: _cipher, ...rest } = format
        return { ...rest, url }
      })
    const streamingData = asRecord(response.streamingData) ?? {}
    return {
      ...response,
      streamingData: {
        ...streamingData,
        formats: rewrite(streamingData.formats),
        adaptiveFormats: rewrite(streamingData.adaptiveFormats),
      },
    }
  }

  return {
    playerScripts,
    poTokens,

    async supported(rungs, ctx) {
      const supported = new Set<string>()
      // The player script and BotGuard's challenge are YouTube pages: only the full tier reads them.
      if (evaluator === undefined || ctx.capabilities.youtube !== 'full') return supported
      const needsOrigin = rungs.some((rung) => rung.kind === 'attested' || rung.kind === 'sabr')
      const attestable = needsOrigin && (await evaluatorOrigin(ctx)) === ATTESTATION_ORIGIN
      for (const rung of rungs) {
        const ok =
          rung.kind === 'deciphered'
            ? rung.client.fields.userAgent === undefined || options.sendsUserAgent === true
            : rung.kind === 'attested'
              ? attestable
              : rung.kind === 'sabr'
                ? attestable && ctx.capabilities.mediaBytes && ctx.platform !== 'android'
                : false
        if (ok) supported.add(rung.id)
      }
      return supported
    },

    async prepare(ctx, rung): Promise<AdvancedPlayerCall> {
      required()
      const player = await playerScripts.current(ctx)
      const userAgent = rung.client.fields.userAgent
      return {
        payload: {
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: 'HTML5_PREF_WANTS',
              signatureTimestamp: player.signatureTimestamp,
            },
          },
        },
        ...(typeof userAgent === 'string' && options.sendsUserAgent === true
          ? { headers: { 'User-Agent': userAgent } }
          : {}),
      }
    },

    async streamOptions(ctx, rung, response, videoId, config) {
      const tools = required()
      if (rung.kind === 'deciphered') {
        const deciphered = await decipheredResponse(ctx, rung, response)
        return streamOptionsOf(deciphered, videoId, rung, config, now())
      }
      const tokenFor = () => tools.poTokens.tokenFor(ctx, videoId)
      if (rung.kind === 'attested') {
        const deciphered = await decipheredResponse(ctx, rung, response, tokenFor)
        return streamOptionsOf(deciphered, videoId, rung, config, now())
      }
      if (rung.kind !== 'sabr') return []
      const sabrUrl = asString(at(response, 'streamingData', 'serverAbrStreamingUrl'))
      const entry = sabrUrl === undefined ? undefined : cipheredUrlOf({ url: sabrUrl })
      if (entry === undefined) return []
      const player = await playerScripts.current(ctx)
      const [url] = await decipherUrls(tools.evaluator, player, [entry], {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (url === undefined) return []
      return sabrStreamOptions(response, {
        videoId,
        rung,
        url,
        poToken: await tokenFor(),
        now: now(),
      })
    },
  }
}
