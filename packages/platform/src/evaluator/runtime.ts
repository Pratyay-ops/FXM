/**
 * The evaluator's runtime: what runs inside the isolated document (`eval.html`) and answers the
 * requests of `protocol.ts`. It compiles and runs scripts with the `Function` constructor, which
 * is why the document's policy is the only one in FXM that allows `'unsafe-eval'`, and it drives
 * BotGuard through bgutils-js (MIT): load the interpreter and program of a challenge, take a
 * snapshot, and mint web PO tokens once the host has exchanged that snapshot for an integrity
 * token.
 *
 * The runtime makes no network request of its own, and the document's policy forbids any
 * (`connect-src 'none'`): the host fetches BotGuard's challenge and its integrity token through
 * the platform's `fetch` and hands them in.
 *
 * @module
 */

import type { JsonValue } from '@fxm/core'
import { BotGuardClient } from 'bgutils-js/botguard'
import type { WebPoSignalOutput } from 'bgutils-js/shared-types'
import { WebPoMinter } from 'bgutils-js/webpo'
import {
  EVALUATOR_CHANNEL,
  type EvaluatorErrorCode,
  type EvaluatorRequest,
  type EvaluatorResponse,
  isJsonValue,
  parseEvaluatorRequest,
  requestIdOf,
} from './protocol'

/** How many functions `define` keeps; defining one more forgets the one used least recently. */
export const MAX_DEFINED_FUNCTIONS = 8

/** How long a BotGuard snapshot may take when the request names no timeout, in milliseconds. */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10_000

/** Answers evaluator requests. Create one with {@link createEvaluatorRuntime}. */
export interface EvaluatorRuntime {
  /**
   * Answers one message: a response for a request, a `bad-request` response for a malformed
   * message that carries an id, and `undefined` for anything that is no evaluator message.
   */
  handle(message: unknown): Promise<EvaluatorResponse | undefined>
}

/** A compiled script: a function of the request's `args`. */
type Compiled = (args: JsonValue) => unknown

/** The BotGuard session of the last snapshot. */
interface BotGuardSession {
  readonly client: BotGuardClient
  readonly signals: WebPoSignalOutput
  integrityToken?: string
  minter?: WebPoMinter
}

/** A failure with the code the response carries. */
class RuntimeFailure extends Error {
  constructor(
    readonly code: EvaluatorErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** A short, single-line description of a thrown value, for an error message. */
function describe(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'a non-error value was thrown'
  return text.replace(/\s+/gu, ' ').slice(0, 300)
}

/**
 * Creates the runtime. Scripts and BotGuard run in the global scope of the realm this module
 * runs in: the evaluator document's `window`, or Node's global in tests.
 *
 * Scripts are compiled as async functions, so they may `await`.
 *
 * The constructors it relies on (`Function`, `JSON`, `Map`, `Promise`) are captured when it is
 * created, so a script that replaces those globals changes nothing about how later requests are
 * handled.
 */
export function createEvaluatorRuntime(): EvaluatorRuntime {
  const global = globalThis as unknown as Record<string, unknown>
  const FunctionConstructor = Function
  const AsyncFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
    ...parameters: string[]
  ) => Compiled
  const stringify = JSON.stringify
  const parse = JSON.parse
  const defined = new Map<string, Compiled>()
  let session: BotGuardSession | undefined

  function compile(source: string): Compiled {
    try {
      return new AsyncFunctionConstructor('args', source)
    } catch (error) {
      throw new RuntimeFailure('script-error', `The script does not compile: ${describe(error)}`)
    }
  }

  async function run(compiled: Compiled, args: JsonValue): Promise<JsonValue> {
    let value: unknown
    try {
      value = await compiled.call(undefined, args)
    } catch (error) {
      throw new RuntimeFailure('script-error', `The script failed: ${describe(error)}`)
    }
    if (value === undefined) return null
    if (isJsonValue(value)) return value
    try {
      const copy: unknown = parse(stringify(value))
      if (isJsonValue(copy)) return copy
    } catch {
      // Not serializable either.
    }
    throw new RuntimeFailure('not-json', 'The script returned something that is not JSON')
  }

  function keep(key: string, compiled: Compiled): void {
    defined.delete(key)
    defined.set(key, compiled)
    while (defined.size > MAX_DEFINED_FUNCTIONS) {
      const oldest = defined.keys().next().value
      if (oldest === undefined) break
      defined.delete(oldest)
    }
  }

  async function snapshot(
    params: Extract<EvaluatorRequest, { method: 'botguard.snapshot' }>['params'],
  ): Promise<string> {
    const previous = session
    session = undefined
    // Best effort: a VM that never started its functions would only time out.
    previous?.client.shutdown().catch(() => {})
    if (params.pageConfig !== undefined) {
      const yt = global.yt
      global.yt = {
        ...(typeof yt === 'object' && yt !== null ? yt : {}),
        config_: params.pageConfig,
      }
    }
    try {
      new FunctionConstructor(params.interpreter)()
    } catch (error) {
      throw new RuntimeFailure(
        'botguard-unavailable',
        `BotGuard's interpreter failed: ${describe(error)}`,
      )
    }
    const vm = global[params.globalName] as { a?: unknown } | undefined
    if (typeof vm !== 'object' || vm === null || typeof vm.a !== 'function') {
      throw new RuntimeFailure(
        'botguard-unavailable',
        `BotGuard's interpreter defined no VM named ${params.globalName}`,
      )
    }
    let client: BotGuardClient
    const signals: WebPoSignalOutput = []
    let response: string
    try {
      client = await BotGuardClient.create({
        program: params.program,
        globalName: params.globalName,
        globalObject: global,
      })
      response = await client.snapshot(
        { webPoSignalOutput: signals },
        params.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      )
    } catch (error) {
      throw new RuntimeFailure('botguard-failed', `BotGuard's snapshot failed: ${describe(error)}`)
    }
    if (typeof response !== 'string' || response === '') {
      throw new RuntimeFailure('botguard-failed', 'BotGuard answered no snapshot')
    }
    session = { client, signals }
    return response
  }

  async function mint(
    params: Extract<EvaluatorRequest, { method: 'botguard.mint' }>['params'],
  ): Promise<string[]> {
    const current = session
    if (current === undefined) {
      throw new RuntimeFailure('no-botguard-session', 'There is no BotGuard snapshot to mint with')
    }
    try {
      if (current.minter === undefined || current.integrityToken !== params.integrityToken) {
        current.minter = await WebPoMinter.create(
          { integrityToken: params.integrityToken },
          current.signals,
        )
        current.integrityToken = params.integrityToken
      }
      const tokens: string[] = []
      for (const binding of params.contentBindings) {
        tokens.push(await current.minter.mintAsWebsafeString(binding))
      }
      return tokens
    } catch (error) {
      throw new RuntimeFailure('botguard-failed', `Minting failed: ${describe(error)}`)
    }
  }

  async function answer(request: EvaluatorRequest): Promise<JsonValue> {
    switch (request.method) {
      case 'evaluate':
        return run(compile(request.params.source), request.params.args)
      case 'define':
        keep(request.params.key, compile(request.params.source))
        return null
      case 'invoke': {
        const compiled = defined.get(request.params.key)
        if (compiled === undefined) {
          throw new RuntimeFailure('unknown-key', `Nothing is defined as ${request.params.key}`)
        }
        keep(request.params.key, compiled)
        return run(compiled, request.params.args)
      }
      case 'botguard.snapshot':
        return snapshot(request.params)
      case 'botguard.mint':
        return mint(request.params)
    }
  }

  return {
    async handle(message) {
      const request = parseEvaluatorRequest(message)
      if (request === undefined) {
        const id = requestIdOf(message)
        if (id === undefined) return undefined
        return {
          channel: EVALUATOR_CHANNEL,
          id,
          ok: false,
          error: { code: 'bad-request', message: 'The request is malformed' },
        }
      }
      try {
        const result = await answer(request)
        return { channel: EVALUATOR_CHANNEL, id: request.id, ok: true, result }
      } catch (error) {
        const failure =
          error instanceof RuntimeFailure
            ? error
            : new RuntimeFailure('script-error', describe(error))
        return {
          channel: EVALUATOR_CHANNEL,
          id: request.id,
          ok: false,
          error: { code: failure.code, message: failure.message },
        }
      }
    },
  }
}
