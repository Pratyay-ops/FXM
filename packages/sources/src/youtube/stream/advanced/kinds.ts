/**
 * The experimental rungs as rung kinds of the ladder (`../kinds.ts`): `deciphered`, `attested`
 * and `sabr`. The ladder runs a rung only when it is given its kind, so a config parsed without
 * these kinds, or a source created without them, leaves the experimental rungs out:
 *
 * ```ts
 * const advanced = createAdvancedRungs({ evaluator }) // the platform's isolated evaluator
 * const streamConfig = parseStreamConfig(document, { kinds: advanced.kinds })
 * const audio = createYouTubeAudioSource({ session, streamConfig, rungKinds: advanced.kinds })
 * ```
 *
 * Each kind maps the hook of `hook.ts` onto the ladder: `canRun` as it is, `prepare` and one
 * `callPlayer` as `call`, and `streamOptions` as `options`.
 *
 * @module
 */

import { FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import type { StreamRungConfig, StreamRungKindParser } from '../config'
import type { StreamRungKind } from '../kinds'
import { callPlayer } from '../player'
import type { AdvancedRungs } from './hook'

/** The kinds of the experimental rungs. */
export const ADVANCED_RUNG_KIND_NAMES = ['deciphered', 'attested', 'sabr'] as const

/** One of the {@link ADVANCED_RUNG_KIND_NAMES}. */
export type AdvancedRungKindName = (typeof ADVANCED_RUNG_KIND_NAMES)[number]

/**
 * How `parseStreamConfig` reads the experimental rungs where no evaluator is at hand, e.g. to
 * check a config document: they have no settings of their own.
 */
export const ADVANCED_RUNG_READERS: readonly StreamRungKindParser[] = Object.freeze(
  ADVANCED_RUNG_KIND_NAMES.map((kind) => Object.freeze({ kind })),
)

/**
 * Runs one of the rung's own steps: the player script, deciphering, BotGuard or the evaluator.
 * Its failure counts against the rung and lets the next one try, which the ladder does for a
 * `Parse` failure; the caller's cancellation and a rate limit still stop the ladder.
 */
async function ownStep<T>(
  ctx: ProviderContext,
  rung: StreamRungConfig,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (ctx.signal?.aborted || isFxmError(error, 'RateLimited') || isFxmError(error, 'Parse')) {
      throw error
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new FxmError('Parse', `The ${rung.id} rung failed: ${reason}`, { cause: error })
  }
}

/**
 * The rung kinds that run the experimental rungs through `hook`: pass them to
 * `parseStreamConfig` (`kinds`) and to `createYouTubeAudioSource` (`rungKinds`).
 */
export function advancedRungKinds(hook: AdvancedRungs): readonly StreamRungKind[] {
  return Object.freeze(
    ADVANCED_RUNG_KIND_NAMES.map(
      (kind): StreamRungKind =>
        Object.freeze({
          kind,
          canRun: (rung: StreamRungConfig, ctx: ProviderContext) => hook.canRun(rung, ctx),
          async call(ctx, rung, videoId, tools) {
            const extra = await ownStep(ctx, rung, () => hook.prepare(ctx, rung, videoId))
            return callPlayer(ctx, rung.client, videoId, {
              ...tools,
              ...(extra.payload === undefined ? {} : { payload: extra.payload }),
              ...(extra.headers === undefined ? {} : { headers: extra.headers }),
            })
          },
          options: (ctx, rung, videoId, answer, tools) =>
            ownStep(ctx, rung, () => hook.streamOptions(ctx, rung, answer, videoId, tools.config)),
        } satisfies StreamRungKind),
    ),
  )
}
