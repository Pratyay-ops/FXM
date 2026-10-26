/**
 * The sources the embed can play: those `integration.ts` wires providers in for. The controller
 * asks before it creates the platform, so a player for anything else contacts no service (no
 * FXM Connect check, no Lite self-test), and production builds of the app offer to share
 * players for these sources only. Kept free of the providers on purpose: the app imports it.
 *
 * @module
 */

import { parseId } from '@fxm/core'
import type { EmbedSource, EmbedTarget } from './target'

/**
 * The wired sources: those `createEmbedServices` has providers for (`integration.test.ts` keeps
 * the two in step): `ytm` and `yt` (stages 1.3 and 1.4) and `archive` (1.6). Jamendo joins once
 * the build has a `client_id` for it.
 */
export const WIRED_SOURCES: ReadonlySet<EmbedSource> = new Set<EmbedSource>([
  'ytm',
  'yt',
  'archive',
])

/** Whether the embed can play `target`: its source is among `wired`. */
export function isWired(target: EmbedTarget, wired: ReadonlySet<string> = WIRED_SOURCES): boolean {
  return wired.has(parseId(target.id).source)
}
