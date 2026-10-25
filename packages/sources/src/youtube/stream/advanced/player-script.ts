/**
 * YouTube's player script, which the deciphered, attested and SABR rungs need: its signature
 * and `n` functions turn a format's ciphered URL into one googlevideo serves, and its
 * `signatureTimestamp` must go with the `/player` call whose URLs it deciphers.
 *
 * The player's ID comes from `https://www.youtube.com/iframe_api`, the script itself from
 * `/s/player/<id>/player_es6.vflset/en_US/base.js` (about 2.6 MB). youtubei.js (MIT) parses it,
 * without running any of it, and extracts the functions into a small script of their own, which
 * only the isolated evaluator ever runs (`decipher.ts`). Both requests go through `ctx.fetch`; on
 * the web they need FXM Connect, like any YouTube page other than the InnerTube API.
 *
 * The extracted script is kept in memory, and through an optional {@link PlayerScriptStore}
 * across restarts, keyed by the player's ID. After {@link PlayerScriptsOptions.maxAgeMs} the ID is
 * checked again (one small request), and the script is fetched again only when the ID changed.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { Player } from 'youtubei.js'
import { fetchWithTimeout } from '../../../shared'
import { requestFailure } from '../../errors'

/** Where the current player's ID is read. */
export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api'

/** The prefix of every player script URL. */
export const PLAYER_SCRIPT_PREFIX = 'https://www.youtube.com/s/player/'

/** A player's ID: hexadecimal, as YouTube names its player builds (`cbcfbf2f`). */
const PLAYER_ID = /^[0-9a-f]{6,32}$/u

/** The longest extracted script kept. */
const MAX_SCRIPT = 4_000_000

/** The extracted functions of one player. */
export interface PlayerScript {
  /** The player's ID, e.g. `cbcfbf2f`. */
  readonly playerId: string
  /** The `signatureTimestamp` of this player, which `/player` calls must send. */
  readonly signatureTimestamp: number
  /**
   * youtubei.js's extract: a script that defines `exportedVars.nsigFunction` (see
   * `decipher.ts`). It is code from YouTube's player and runs only in the isolated evaluator.
   */
  readonly script: string
  /** When the player's ID was last confirmed, in epoch milliseconds. */
  readonly checkedAt: number
}

/** Where the extracted script can be kept between sessions, e.g. IndexedDB or app storage. */
export interface PlayerScriptStore {
  /** The script saved earlier, if any. It is checked before use. */
  load(): unknown | Promise<unknown>
  /** Keeps the script. */
  save(script: PlayerScript): void | Promise<void>
}

/** How a player script is extracted; youtubei.js by default. */
export type PlayerScriptExtractor = (
  playerId: string,
  fetchScript: (url: string) => Promise<Response>,
) => Promise<{ readonly signatureTimestamp: number; readonly script: string }>

/** Options for {@link PlayerScripts}. */
export interface PlayerScriptsOptions {
  /** Where to keep the script; in memory only by default. */
  store?: PlayerScriptStore
  /** How long a player's ID is trusted before it is checked again; 6 hours by default. */
  maxAgeMs?: number
  /** How long one request may take, in milliseconds; 30 s by default. */
  timeoutMs?: number
  /** The clock, for tests. */
  now?: () => number
  /** Extracts the functions from the player script; youtubei.js by default. */
  extract?: PlayerScriptExtractor
}

/** Reads a stored script, or `undefined` when it is missing or malformed (fail closed). */
function readStored(value: unknown): PlayerScript | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { playerId, signatureTimestamp, script, checkedAt } = value as Partial<
    Record<keyof PlayerScript, unknown>
  >
  const ok =
    typeof playerId === 'string' &&
    PLAYER_ID.test(playerId) &&
    Number.isSafeInteger(signatureTimestamp) &&
    (signatureTimestamp as number) > 0 &&
    typeof script === 'string' &&
    script.length > 0 &&
    script.length <= MAX_SCRIPT &&
    typeof checkedAt === 'number' &&
    Number.isFinite(checkedAt)
  return ok
    ? { playerId, signatureTimestamp: signatureTimestamp as number, script, checkedAt }
    : undefined
}

/**
 * The player's ID in the text of `/iframe_api`, which loads
 * `https://www.youtube.com/s/player/<id>/www-widgetapi.vflset/www-widgetapi.js` (with escaped
 * slashes).
 */
export function playerIdOf(iframeApi: string): string | undefined {
  const id = /\/s\\?\/player\\?\/([0-9a-f]{6,32})\\?\//u.exec(iframeApi)?.[1]
  return id !== undefined && PLAYER_ID.test(id) ? id : undefined
}

/** Extracts the functions with youtubei.js's `Player`, which parses but never runs the script. */
export const extractWithYoutubei: PlayerScriptExtractor = async (playerId, fetchScript) => {
  const player = await Player.create(
    undefined,
    async (input) => fetchScript(input instanceof Request ? input.url : String(input)),
    undefined,
    playerId,
  )
  const script = player.data?.output
  if (
    typeof script !== 'string' ||
    script === '' ||
    !player.data?.exported.includes('nsigFunction')
  ) {
    throw new FxmError(
      'Parse',
      `youtubei.js found no n and signature functions in player ${playerId}`,
    )
  }
  return { signatureTimestamp: player.signature_timestamp, script }
}

/** The player script of the device, fetched when needed. */
export class PlayerScripts {
  #current: PlayerScript | undefined
  #loaded: Promise<void> | undefined
  #pending: Promise<PlayerScript> | undefined
  readonly #store: PlayerScriptStore | undefined
  readonly #maxAgeMs: number
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #extract: PlayerScriptExtractor

  constructor(options: PlayerScriptsOptions = {}) {
    this.#store = options.store
    this.#maxAgeMs = options.maxAgeMs ?? 6 * 3_600_000
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#now = options.now ?? Date.now
    this.#extract = options.extract ?? extractWithYoutubei
  }

  /**
   * The current player's script: the one in memory or the store while its ID is fresh, else
   * after checking the ID, and fetching and extracting the script when it changed.
   *
   * @throws FxmError `Network` when a request fails, `Parse` when the ID or the functions cannot
   * be found, or the caller's cancellation.
   */
  async current(ctx: ProviderContext): Promise<PlayerScript> {
    this.#loaded ??= this.#load()
    await this.#loaded
    const current = this.#current
    if (current !== undefined && this.#now() - current.checkedAt < this.#maxAgeMs) return current
    // One fetch at a time for every caller, without any one caller's signal.
    this.#pending ??= this.#refresh(ctx).finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  /** Forgets the script, e.g. after its functions failed, so the next call fetches it again. */
  invalidate(): void {
    this.#current = undefined
  }

  async #load(): Promise<void> {
    try {
      const stored = readStored(await this.#store?.load())
      if (stored !== undefined && this.#current === undefined) this.#current = stored
    } catch {
      // Without the store, the script is fetched.
    }
  }

  #keep(script: PlayerScript): PlayerScript {
    this.#current = script
    void (async () => {
      try {
        await this.#store?.save(script)
      } catch {
        // The script stays in memory.
      }
    })()
    return script
  }

  async #get(ctx: ProviderContext, url: string): Promise<Response> {
    let response: Response
    try {
      response = await fetchWithTimeout(ctx.fetch, url, {
        method: 'GET',
        credentials: 'omit',
        timeoutMs: this.#timeoutMs,
      })
    } catch (error) {
      throw requestFailure(error, url, ctx.signal)
    }
    if (!response.ok) {
      throw new FxmError('Network', `YouTube answered ${url} with HTTP ${response.status}`)
    }
    return response
  }

  async #refresh(ctx: ProviderContext): Promise<PlayerScript> {
    const playerId = playerIdOf(await (await this.#get(ctx, IFRAME_API_URL)).text())
    if (playerId === undefined) {
      throw new FxmError('Parse', "YouTube's iframe_api names no player")
    }
    const now = this.#now()
    const current = this.#current
    if (current?.playerId === playerId) return this.#keep({ ...current, checkedAt: now })
    let extracted: { readonly signatureTimestamp: number; readonly script: string }
    try {
      extracted = await this.#extract(playerId, (url) => {
        if (!url.startsWith(`${PLAYER_SCRIPT_PREFIX}${playerId}/`)) {
          return Promise.reject(new FxmError('Unsupported', `Not the player script: ${url}`))
        }
        return this.#get(ctx, url)
      })
    } catch (error) {
      if (isFxmError(error)) throw error
      throw new FxmError('Parse', `The script of player ${playerId} could not be read`, {
        cause: error,
      })
    }
    if (!Number.isSafeInteger(extracted.signatureTimestamp) || extracted.signatureTimestamp <= 0) {
      throw new FxmError('Parse', `Player ${playerId} has no signatureTimestamp`)
    }
    if (extracted.script.length > MAX_SCRIPT) {
      throw new FxmError('Parse', `The extract of player ${playerId} is too long`)
    }
    return this.#keep({ playerId, ...extracted, checkedAt: now })
  }
}
