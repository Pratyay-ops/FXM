/**
 * The hook through which the ladder of `../resolver.ts` tries the experimental rungs: rungs of
 * the kinds `deciphered`, `attested` and `sabr`. The ladder keeps everything the rungs have in
 * common (the order, health, bot checks, playability, the end-of-file probe); the hook adds what
 * differs: a rung's extra `/player` fields, and how its stream options come out of a playable
 * answer. `createAdvancedRungs()` (`rungs.ts`) implements it, and `kinds.ts` maps it onto the
 * ladder's rung kinds (`../kinds.ts`).
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import type { JsonRecord } from '../../json'
import type { StreamConfig, StreamRungConfig } from '../config'
import type { YouTubeStreamOption } from '../formats'

/** What a rung adds to its `/player` call. */
export interface AdvancedPlayerCall {
  /** More top-level payload fields, such as the `playbackContext` with a `signatureTimestamp`. */
  readonly payload?: JsonRecord
  /** More request headers, such as the client's `User-Agent` where the transport sends it. */
  readonly headers?: Readonly<Record<string, string>>
}

/** The hook for the rungs of the experimental kinds. */
export interface AdvancedRungs {
  /**
   * Whether `rung` can be tried in `ctx` (its tier, platform and the evaluator it has), decided
   * at once, without a request and without starting the evaluator: the ladder leaves the others
   * out, as if they were off, and never waits for this.
   */
  canRun(rung: StreamRungConfig, ctx: ProviderContext): boolean
  /** Prepares the `/player` call of `rung` for `videoId`. */
  prepare(
    ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
  ): Promise<AdvancedPlayerCall>
  /**
   * The stream options in a playable `/player` answer of `rung`, unprobed: deciphered direct URLs
   * (`progressive`), which the ladder then probes like any other, or one SABR option per format.
   */
  streamOptions(
    ctx: ProviderContext,
    rung: StreamRungConfig,
    response: JsonRecord,
    videoId: string,
    config: StreamConfig,
  ): Promise<YouTubeStreamOption[]>
}
