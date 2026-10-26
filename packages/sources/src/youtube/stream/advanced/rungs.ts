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
 * `createAdvancedRungs()` implements the hook of `hook.ts` for them, and maps it onto the ladder's
 * rung kinds (`kinds.ts`): pass its `kinds` to `parseStreamConfig` (`kinds`) and to
 * `createYouTubeAudioSource` (`rungKinds`). What each rung needs, and the live results, are in
 * this folder's `README.md`.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { arrayAt, asNumber, asRecord, asString, at, type JsonRecord } from '../../json'
import type { StreamRungConfig } from '../config'
import { streamOptionsOf } from '../formats'
import type { StreamRungKind } from '../kinds'
import { WebPoTokens } from './botguard'
import { type CipheredUrl, cipheredUrlOf, decipherUrls } from './decipher'
import {
  ATTESTATION_ORIGIN,
  evaluatorCodeOf,
  isEvaluatorDown,
  type StreamEvaluator,
} from './evaluator'
import type { AdvancedPlayerCall, AdvancedRungs } from './hook'
import { advancedRungKinds } from './kinds'
import {
  type PlayerScript,
  type PlayerScriptExtractor,
  type PlayerScriptStore,
  PlayerScripts,
} from './player-script'
import { sabrStreamOptions } from './sabr'

/**
 * How long the rungs leave an evaluator alone after its document could not start, or was gone,
 * in milliseconds: meanwhile no rung that needs it is tried, so no resolution waits for it.
 */
export const EVALUATOR_RETRY_MS = 10 * 60_000

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
  /** How long an evaluator that could not start is left alone; {@link EVALUATOR_RETRY_MS} by default. */
  evaluatorRetryMs?: number
  /** The clock, for tests. */
  now?: () => number
  /** Extracts the player script's functions; youtubei.js by default. For tests. */
  extractPlayerScript?: PlayerScriptExtractor
}

/** The experimental rungs, with their caches for diagnostics and tests. */
export interface AdvancedRungsHook extends AdvancedRungs {
  /**
   * The rungs' kinds for the ladder (`kinds.ts`): pass them to `parseStreamConfig` (`kinds`) and
   * to `createYouTubeAudioSource` (`rungKinds`).
   */
  readonly kinds: readonly StreamRungKind[]
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

/**
 * Whether deciphering failed in the player's functions themselves (they threw, answered no JSON,
 * or gave no signature or `n`), which a new player may explain. A cancellation, a timeout or an
 * evaluator that can't be reached says nothing about the script.
 */
function scriptFailed(error: unknown): boolean {
  const code = evaluatorCodeOf(error)
  if (code !== undefined) return code === 'script-error' || code === 'not-json'
  return isFxmError(error, 'Parse')
}

/**
 * `evaluator`, with every failure that says its document could not start or is gone reported to
 * `down`.
 */
function watched(evaluator: StreamEvaluator, down: () => void): StreamEvaluator {
  const watch = <T>(work: Promise<T>): Promise<T> =>
    work.catch((error: unknown) => {
      if (isEvaluatorDown(error)) down()
      throw error
    })
  return {
    origin: evaluator.origin,
    ready: (callOptions) => watch(evaluator.ready(callOptions)),
    evaluate: (source, args, callOptions) => watch(evaluator.evaluate(source, args, callOptions)),
    botguardSnapshot: (challenge, callOptions) =>
      watch(evaluator.botguardSnapshot(challenge, callOptions)),
    mintWebPoTokens: (integrityToken, bindings, callOptions) =>
      watch(evaluator.mintWebPoTokens(integrityToken, bindings, callOptions)),
  }
}

/** Creates the hook for the experimental rungs. */
export function createAdvancedRungs(options: AdvancedRungsOptions = {}): AdvancedRungsHook {
  const now = options.now ?? Date.now
  const retryMs = options.evaluatorRetryMs ?? EVALUATOR_RETRY_MS
  /** Until when the evaluator is left alone, after its document could not start. */
  let evaluatorDownUntil = Number.NEGATIVE_INFINITY
  const evaluator =
    options.evaluator === undefined
      ? undefined
      : watched(options.evaluator, () => {
          evaluatorDownUntil = now() + retryMs
        })
  // BotGuard's attestation works only in a document at YouTube's origin, which the evaluator
  // knows without starting.
  const attestable = evaluator?.origin === ATTESTATION_ORIGIN
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

  /**
   * Deciphers `entries` with the player's functions. When the functions themselves fail, a new
   * player may have changed them: its ID is checked again before the next use.
   */
  async function decipher(
    ctx: ProviderContext,
    player: PlayerScript,
    entries: readonly CipheredUrl[],
  ): Promise<string[]> {
    try {
      return await decipherUrls(required().evaluator, player, entries, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (error) {
      if (scriptFailed(error)) playerScripts.invalidate()
      throw error
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
    const urls = await decipher(
      ctx,
      player,
      ciphered.map(({ entry }) => entry),
    )
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

  const hook: AdvancedRungs = {
    canRun(rung, ctx) {
      // The player script and BotGuard's challenge are YouTube pages: only the full tier reads them.
      if (evaluator === undefined || ctx.capabilities.youtube !== 'full') return false
      if (now() < evaluatorDownUntil) return false
      switch (rung.kind) {
        case 'deciphered':
          return rung.client.fields.userAgent === undefined || options.sendsUserAgent === true
        case 'attested':
          return attestable
        case 'sabr':
          return attestable && ctx.capabilities.mediaBytes && ctx.platform !== 'android'
        default:
          return false
      }
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
      const [url] = await decipher(ctx, player, [entry])
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
  return { ...hook, playerScripts, poTokens, kinds: advancedRungKinds(hook) }
}
