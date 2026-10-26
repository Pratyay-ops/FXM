/**
 * The messages between FXM and its isolated evaluator: the document that runs code FXM must not
 * run in its own pages, namely YouTube's player script (to decipher stream URLs) and Google's
 * BotGuard (to mint web PO tokens). The same messages travel over every platform's channel: a
 * `postMessage` to a sandboxed iframe on the web, and a mailbox read through the native webview's
 * script evaluation on desktop and Android (see `mailbox.ts`).
 *
 * Every message is plain JSON, so it survives `postMessage`, `JSON.stringify` and a native bridge
 * alike. Both sides check what they receive with the parsers here and drop anything else.
 *
 * @module
 */

import type { JsonObject, JsonValue } from '@fxm/core'

/** The `channel` of every evaluator message, so that unrelated messages are never mistaken for one. */
export const EVALUATOR_CHANNEL = 'fxm-evaluator'

/**
 * The protocol version the document announces. A host refuses a document of another version:
 * an app and an `eval.html` from different builds would misread each other. Version 2: a framed
 * document echoes its nonce and hands its parent a `MessagePort` with its hello.
 */
export const EVALUATOR_PROTOCOL_VERSION = 2

/**
 * A nonce the web host puts in the fragment of the document's URL (`eval.html#<nonce>`), and
 * which the document echoes in its hello: 16 to 128 URL-safe characters.
 */
export const EVALUATOR_NONCE = /^[\w-]{16,128}$/u

/** The longest script, argument list or interpreter a message may carry, in UTF-16 units. */
export const MAX_EVALUATOR_TEXT = 8_000_000

/** The most content bindings one mint request may name. */
export const MAX_CONTENT_BINDINGS = 16

/** Every {@link EvaluatorMethod}. */
export const EVALUATOR_METHODS = [
  'evaluate',
  'define',
  'invoke',
  'botguard.snapshot',
  'botguard.mint',
] as const

/**
 * What a request asks the document to do:
 *
 * - `evaluate`: run `source` once as the body of a function of `args`, and answer its result
 * - `define`: compile `source` the same way and keep it under `key`, e.g. a player script that
 *   later calls run with different arguments
 * - `invoke`: run the function kept under `key` with `args`
 * - `botguard.snapshot`: load BotGuard's interpreter and program, and answer its snapshot (the
 *   "BotGuard response" that Google's `GenerateIT` endpoint exchanges for an integrity token)
 * - `botguard.mint`: mint web PO tokens for content bindings (video IDs, say) with that
 *   integrity token and the BotGuard session of the last snapshot
 */
export type EvaluatorMethod = (typeof EVALUATOR_METHODS)[number]

/** The parameters of `evaluate`. */
export type EvaluateParams = {
  /** A function body; `args` is in scope, and what it returns (or resolves to) is the result. */
  readonly source: string
  /** The arguments, as JSON. */
  readonly args: JsonValue
}

/** The parameters of `define`. */
export type DefineParams = {
  /** The name to keep the function under, e.g. `player:cbcfbf2f`. */
  readonly key: string
  /** A function body, as for `evaluate`. */
  readonly source: string
}

/** The parameters of `invoke`. */
export type InvokeParams = {
  /** The name a `define` used. */
  readonly key: string
  /** The arguments, as JSON. */
  readonly args: JsonValue
}

/** The parameters of `botguard.snapshot`: a BotGuard challenge, fetched by the host. */
export type BotGuardSnapshotParams = {
  /** BotGuard's interpreter script, which defines the VM as a global named `globalName`. */
  readonly interpreter: string
  /** The challenge's program, which the VM runs. */
  readonly program: string
  /** The name of the global the interpreter defines. */
  readonly globalName: string
  /**
   * The page configuration BotGuard reads as `yt.config_`, if the challenge comes from a YouTube
   * page (it reads the page's `EVENT_ID`).
   */
  readonly pageConfig?: JsonObject
  /** How long the snapshot may take, in milliseconds. */
  readonly timeoutMs?: number
}

/** The parameters of `botguard.mint`. */
export type BotGuardMintParams = {
  /** The integrity token `GenerateIT` issued for the last snapshot. */
  readonly integrityToken: string
  /** What each token is bound to, e.g. a video ID; one token per binding. */
  readonly contentBindings: readonly string[]
}

/** The parameters of each method. */
export interface EvaluatorParams {
  readonly evaluate: EvaluateParams
  readonly define: DefineParams
  readonly invoke: InvokeParams
  readonly 'botguard.snapshot': BotGuardSnapshotParams
  readonly 'botguard.mint': BotGuardMintParams
}

/** One request to the document. `id` matches it with its response. */
export type EvaluatorRequest = {
  [M in EvaluatorMethod]: {
    readonly channel: typeof EVALUATOR_CHANNEL
    readonly id: number
    readonly method: M
    readonly params: EvaluatorParams[M]
  }
}[EvaluatorMethod]

/** Every {@link EvaluatorErrorCode}. */
export const EVALUATOR_ERROR_CODES = [
  'bad-request',
  'unknown-key',
  'script-error',
  'not-json',
  'timeout',
  'botguard-unavailable',
  'botguard-failed',
  'no-botguard-session',
] as const

/**
 * Why the document could not answer a request:
 *
 * - `bad-request`: the request was malformed
 * - `unknown-key`: `invoke` named a function that is not defined (any more): define it again
 * - `script-error`: the script threw or rejected
 * - `not-json`: the script's result is not JSON
 * - `timeout`: the work took too long
 * - `botguard-unavailable`: the interpreter did not define a usable VM
 * - `botguard-failed`: BotGuard failed to load, snapshot or mint
 * - `no-botguard-session`: `botguard.mint` came before any snapshot
 */
export type EvaluatorErrorCode = (typeof EVALUATOR_ERROR_CODES)[number]

/** The document's answer to one request. */
export type EvaluatorResponse =
  | {
      readonly channel: typeof EVALUATOR_CHANNEL
      readonly id: number
      readonly ok: true
      /** The result, as JSON. */
      readonly result: JsonValue
    }
  | {
      readonly channel: typeof EVALUATOR_CHANNEL
      readonly id: number
      readonly ok: false
      /** What went wrong. */
      readonly error: { readonly code: EvaluatorErrorCode; readonly message: string }
    }

/** What the document announces once it is ready for requests. */
export type EvaluatorHello = {
  readonly channel: typeof EVALUATOR_CHANNEL
  readonly type: 'ready'
  /** Its {@link EVALUATOR_PROTOCOL_VERSION}. */
  readonly version: number
  /**
   * The origin of the document's URL, e.g. `https://fxmusic.pages.dev` for `eval.html` on the
   * web (which is still an opaque origin to the browser), `fxm-eval://localhost` on desktop, or
   * `https://www.youtube.com` on Android, whose evaluator WebView loads the document with that
   * base URL. Scripts that look at where they run, such as BotGuard, see this location.
   */
  readonly origin: string
  /**
   * The {@link EVALUATOR_NONCE} of the document's URL, for a framed document: it tells the web
   * host that this hello comes from the document it loaded, not from one that replaced it.
   */
  readonly nonce?: string
}

type Json = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(object: Json, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

function isText(value: unknown, max = MAX_EVALUATOR_TEXT): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Whether `value` is JSON: what `JSON.parse(JSON.stringify(value))` gives back unchanged. Plain
 * objects only (no class instances, typed arrays or functions), finite numbers, at most 64 deep.
 */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  if (typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every((item) => isJsonValue(item, depth + 1))
}

const KEY = /^[\w.:-]{1,64}$/u
const GLOBAL_NAME = /^[A-Za-z_$][\w$]{0,63}$/u

function params(
  method: EvaluatorMethod,
  value: unknown,
): EvaluatorParams[EvaluatorMethod] | undefined {
  if (!isObject(value)) return undefined
  switch (method) {
    case 'evaluate': {
      const source = own(value, 'source')
      const args = own(value, 'args')
      return isText(source) && isJsonValue(args) ? { source, args } : undefined
    }
    case 'define': {
      const key = own(value, 'key')
      const source = own(value, 'source')
      return typeof key === 'string' && KEY.test(key) && isText(source)
        ? { key, source }
        : undefined
    }
    case 'invoke': {
      const key = own(value, 'key')
      const args = own(value, 'args')
      return typeof key === 'string' && KEY.test(key) && isJsonValue(args)
        ? { key, args }
        : undefined
    }
    case 'botguard.snapshot': {
      const interpreter = own(value, 'interpreter')
      const program = own(value, 'program')
      const globalName = own(value, 'globalName')
      const pageConfig = own(value, 'pageConfig')
      const timeoutMs = own(value, 'timeoutMs')
      if (!isText(interpreter) || !isText(program)) return undefined
      if (typeof globalName !== 'string' || !GLOBAL_NAME.test(globalName)) return undefined
      if (pageConfig !== undefined && !(isObject(pageConfig) && isJsonValue(pageConfig))) {
        return undefined
      }
      if (
        timeoutMs !== undefined &&
        !(
          Number.isSafeInteger(timeoutMs) &&
          (timeoutMs as number) > 0 &&
          (timeoutMs as number) <= 120_000
        )
      ) {
        return undefined
      }
      return {
        interpreter,
        program,
        globalName,
        ...(pageConfig === undefined ? {} : { pageConfig: pageConfig as JsonObject }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      }
    }
    case 'botguard.mint': {
      const integrityToken = own(value, 'integrityToken')
      const contentBindings = own(value, 'contentBindings')
      const ok =
        isText(integrityToken, 4096) &&
        Array.isArray(contentBindings) &&
        contentBindings.length > 0 &&
        contentBindings.length <= MAX_CONTENT_BINDINGS &&
        contentBindings.every((binding) => isText(binding, 4096))
      return ok ? { integrityToken, contentBindings: contentBindings as string[] } : undefined
    }
  }
}

/**
 * Reads a request, or `undefined` when `value` is not a well-formed one. The id of a malformed
 * request that still carries one is available through {@link requestIdOf}, so that the document
 * can answer it with `bad-request` instead of leaving the host to time out.
 */
export function parseEvaluatorRequest(value: unknown): EvaluatorRequest | undefined {
  if (!isObject(value) || own(value, 'channel') !== EVALUATOR_CHANNEL) return undefined
  const id = own(value, 'id')
  const method = own(value, 'method')
  if (!isId(id) || !(EVALUATOR_METHODS as readonly unknown[]).includes(method)) return undefined
  const parsed = params(method as EvaluatorMethod, own(value, 'params'))
  if (parsed === undefined) return undefined
  return { channel: EVALUATOR_CHANNEL, id, method, params: parsed } as EvaluatorRequest
}

/** The `id` of an evaluator message, if it carries a usable one. */
export function requestIdOf(value: unknown): number | undefined {
  if (!isObject(value) || own(value, 'channel') !== EVALUATOR_CHANNEL) return undefined
  const id = own(value, 'id')
  return isId(id) ? id : undefined
}

/** Reads a response, or `undefined` when `value` is not a well-formed one. */
export function parseEvaluatorResponse(value: unknown): EvaluatorResponse | undefined {
  if (!isObject(value) || own(value, 'channel') !== EVALUATOR_CHANNEL) return undefined
  const id = own(value, 'id')
  if (!isId(id)) return undefined
  const ok = own(value, 'ok')
  if (ok === true) {
    const result = own(value, 'result')
    return isJsonValue(result) ? { channel: EVALUATOR_CHANNEL, id, ok, result } : undefined
  }
  if (ok !== false) return undefined
  const error = own(value, 'error')
  if (!isObject(error)) return undefined
  const code = own(error, 'code')
  const message = own(error, 'message')
  if (!(EVALUATOR_ERROR_CODES as readonly unknown[]).includes(code)) return undefined
  return {
    channel: EVALUATOR_CHANNEL,
    id,
    ok,
    error: {
      code: code as EvaluatorErrorCode,
      message: typeof message === 'string' ? message.slice(0, 500) : '',
    },
  }
}

/** Reads the document's announcement, or `undefined` when `value` is not one. */
export function parseEvaluatorHello(value: unknown): EvaluatorHello | undefined {
  if (!isObject(value) || own(value, 'channel') !== EVALUATOR_CHANNEL) return undefined
  const version = own(value, 'version')
  const origin = own(value, 'origin')
  const nonce = own(value, 'nonce')
  if (own(value, 'type') !== 'ready' || !isId(version) || !isText(origin, 200)) return undefined
  if (nonce !== undefined && !(typeof nonce === 'string' && EVALUATOR_NONCE.test(nonce))) {
    return undefined
  }
  return {
    channel: EVALUATOR_CHANNEL,
    type: 'ready',
    version,
    origin,
    ...(nonce === undefined ? {} : { nonce }),
  }
}
