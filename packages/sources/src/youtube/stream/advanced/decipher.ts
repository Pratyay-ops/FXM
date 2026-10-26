/**
 * Deciphering stream URLs with the player script, in the isolated evaluator. A format of the
 * clients these rungs use comes with a `signatureCipher` (the URL, its scrambled signature `s`
 * and the name `sp` of the parameter the signature goes in), and its URL carries an `n`
 * parameter that googlevideo throttles until it is transformed. The player script's functions,
 * extracted by youtubei.js (`player-script.ts`), do both.
 *
 * All the formats of one answer are deciphered in one evaluator call. The extract is defined in
 * the evaluator once per player (key `player:<id>`), so later calls send only their arguments.
 * How the extract is driven follows youtubei.js 18.1.0 (MIT): the extracted function builds a
 * URL object from a stand-in URL, the object's methods apply the transforms, and its `get`
 * returns the results.
 *
 * @module
 */

import { FxmError, type JsonValue } from '@fxm/core'
import { asString, type JsonRecord } from '../../json'
import type { StreamEvaluator } from './evaluator'
import type { PlayerScript } from './player-script'

/** A URL to decipher, with what it needs. */
export interface CipheredUrl {
  /** The URL, as YouTube gave it. */
  readonly url: string
  /** Its `n` parameter, which the player script transforms. */
  readonly n?: string
  /** The scrambled signature, for a URL from a `signatureCipher`. */
  readonly s?: string
  /** The parameter the deciphered signature goes in, `sig` today (`signature` if absent). */
  readonly sp?: string
}

/** What a format's URL needs: its `signatureCipher` (or `cipher`) read, or its plain `url`. */
export function cipheredUrlOf(format: JsonRecord): CipheredUrl | undefined {
  const cipher = asString(format.signatureCipher) ?? asString(format.cipher)
  let url: string | undefined
  let s: string | undefined
  let sp: string | undefined
  if (cipher !== undefined) {
    const params = new URLSearchParams(cipher)
    url = params.get('url') ?? undefined
    s = params.get('s') ?? undefined
    sp = params.get('sp') ?? undefined
    if (url === undefined || s === undefined) return undefined
  } else {
    url = asString(format.url)
  }
  if (url === undefined || !URL.canParse(url)) return undefined
  const n = new URL(url).searchParams.get('n') ?? undefined
  return {
    url,
    ...(n === undefined ? {} : { n }),
    ...(s === undefined ? {} : { s }),
    ...(sp === undefined ? {} : { sp }),
  }
}

/**
 * Runs after the player's extract, in the evaluator, with `args` an array of `{ n, s, sp }`:
 * transforms each, and answers `{ sig, n }` for each (`null` where there was nothing to do).
 */
export const DECIPHER_PROCESSOR = `
const fxmDecipher = (n, s, sp) => {
  const make = typeof exportedVars === 'object' && exportedVars !== null ? exportedVars.nsigFunction : undefined
  if (typeof make !== 'function') throw new Error('The player script defines no n or signature function')
  const target = make('https://fxm.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n), sp, s)
  const prototype = Object.getPrototypeOf(target)
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || name === 'clone' || name === 'set' || name === 'get') continue
    if (typeof target[name] === 'function') target[name]()
  }
  const sig = s ? target.get(sp) : null
  const transformed = n ? target.get('n') : null
  return {
    sig: sig ? decodeURIComponent(sig) : null,
    n: transformed ? decodeURIComponent(transformed) : null,
  }
}
return args.map((entry) => fxmDecipher(entry.n, entry.s, entry.sp))
`

/** What the player script's `n` function answers when it fails inside. */
const N_FAILURE = 'enhanced_except_'

/**
 * Deciphers `urls` with the player's functions in the evaluator: the signature goes in its
 * parameter (`sp`, else `signature`), and `n` is replaced. URLs that need neither come back as
 * they are.
 *
 * @throws FxmError `Parse` when the evaluator fails, or a result is missing or the `n` function
 * failed inside; evaluator errors pass through as they are.
 */
export async function decipherUrls(
  evaluator: StreamEvaluator,
  player: PlayerScript,
  urls: readonly CipheredUrl[],
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const needed = urls.filter((entry) => entry.s !== undefined || entry.n !== undefined)
  if (needed.length === 0) return urls.map((entry) => entry.url)
  const args = needed.map((entry) => ({
    n: entry.n ?? '',
    s: entry.s ?? '',
    sp: entry.sp ?? 'signature',
  }))
  const results = await evaluator.evaluate(
    `${player.script}\n${DECIPHER_PROCESSOR}`,
    args as JsonValue,
    { key: `player:${player.playerId}`, ...(options.signal ? { signal: options.signal } : {}) },
  )
  if (!Array.isArray(results) || results.length !== needed.length) {
    throw new FxmError('Parse', `Player ${player.playerId} deciphered no URLs`)
  }
  const deciphered = new Map<CipheredUrl, string>()
  needed.forEach((entry, index) => {
    const result = results[index] as { sig?: unknown; n?: unknown } | null | undefined
    const url = new URL(entry.url)
    if (entry.s !== undefined) {
      if (typeof result?.sig !== 'string' || result.sig === '') {
        throw new FxmError('Parse', `Player ${player.playerId} deciphered no signature`)
      }
      url.searchParams.set(entry.sp ?? 'signature', result.sig)
    }
    if (entry.n !== undefined) {
      if (typeof result?.n !== 'string' || result.n === '' || result.n.startsWith(N_FAILURE)) {
        throw new FxmError('Parse', `Player ${player.playerId} could not transform n`)
      }
      url.searchParams.set('n', result.n)
    }
    deciphered.set(entry, url.href)
  })
  return urls.map((entry) => deciphered.get(entry) ?? entry.url)
}
