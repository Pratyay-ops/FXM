/**
 * Rung kinds: how the ladder runs the rungs of one `kind`. Stage 1.4 ships {@link DIRECT_RUNGS},
 * one `/player` call whose answer carries playable URLs. Stage 1.11 adds its kinds (deciphered,
 * PO token, SABR) in `stream/advanced/` and hands them to `parseStreamConfig` (`kinds`) and to
 * `createYouTubeAudioSource` (`rungKinds`); rungs of a kind a build doesn't run are left out.
 *
 * The ladder does everything that is the same for every kind: the order and health of the rungs,
 * where each may run (`requires`), bot checks and the visitorData refresh, reading the answer's
 * playability (labelled states, wrong videos), the end-of-file probe of progressive URLs, and the
 * errors. A kind does the rest: it asks YouTube for the video as its rung's client, and turns a
 * playable answer into stream options.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import type { JsonRecord } from '../json'
import type { StreamConfig, StreamRungConfig, StreamRungKindParser } from './config'
import { streamOptionsOf, type YouTubeStreamOption } from './formats'
import { callPlayer, type PlayerAnswer, type PlayerCallOptions } from './player'

/**
 * What the ladder lends a kind for one attempt: what a `/player` call needs (see `callPlayer`,
 * which draws on the budget and handles the visitorData), the config in use and the time.
 */
export interface RungTools extends PlayerCallOptions {
  /** The stream config in use, e.g. for `muxedAudioKbps`. */
  readonly config: StreamConfig
  /** The time of the attempt, in epoch milliseconds. */
  readonly now: number
}

/** How the ladder runs the rungs of one kind. */
export interface StreamRungKind extends StreamRungKindParser {
  /**
   * Whether a rung of this kind can run in `ctx`, besides what its `requires` says: e.g.
   * whether the isolated evaluator could start. Every context by default.
   */
  readonly canRun?: (rung: StreamRungConfig, ctx: ProviderContext) => boolean
  /**
   * Asks YouTube for `videoId` as the rung's client, usually with one `callPlayer`. A bot check
   * comes back as an answer, not an error, so the ladder can handle it. Rejects with an
   * `FxmError`: `Parse` counts against the rung and lets the next one try; anything else
   * (`Network`, `RateLimited`, the caller's cancellation) stops the ladder.
   */
  readonly call: (
    ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
    tools: RungTools,
  ) => Promise<PlayerAnswer>
  /**
   * The stream options of a playable answer about `videoId` (the ladder has checked both), in
   * the rung's order of preference and `unverified`: the ladder probes the end of the
   * progressive ones where the bytes are readable. Rejects like {@link StreamRungKind.call}.
   */
  readonly options: (
    ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
    answer: JsonRecord,
    tools: RungTools,
  ) => Promise<YouTubeStreamOption[]>
}

/**
 * The `direct` rungs of stage 1.4: one `/player` call as the rung's client (VISIONOS, ANDROID),
 * whose answer carries googlevideo URLs that need no deciphering, PO token or SABR.
 */
export const DIRECT_RUNGS: StreamRungKind = Object.freeze({
  kind: 'direct',
  call: (ctx: ProviderContext, rung: StreamRungConfig, videoId: string, tools: RungTools) =>
    callPlayer(ctx, rung.client, videoId, tools),
  options: async (
    _ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
    answer: JsonRecord,
    tools: RungTools,
  ) => streamOptionsOf(answer, videoId, rung, tools.config, tools.now),
})
