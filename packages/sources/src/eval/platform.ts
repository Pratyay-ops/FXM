/**
 * The recorder's network: `@fxm/platform`'s shared request budget and Node transport, loaded at
 * run time by path. The platform cannot be a dependency of this package: it depends on this one
 * (its Lite tier's browser tests play songs through these providers), and pnpm refuses the cycle.
 * Loaded at run time, it also type-checks apart (with the DOM; this package as a web worker), and
 * no provider imports it. `tsc` cannot check the binding, so `platform.test.ts` checks it offline.
 *
 * @module
 */

import type { RecorderBudget } from './recorder'
import { checkpointStorage, type EvalCheckpoint } from './store'

/** The request budget, as the recorder and its commands use it (`RequestBudget` in the platform). */
export interface PlatformBudget extends RecorderBudget {
  /** The budget's state: the hour's calls and the bulk pause. */
  snapshot(): { used: number; remaining: number; bulkPausedUntil?: number; pauseLevel: number }
}

/** What the recorder needs of `@fxm/platform`, with the platform's names. */
export interface PlatformModule {
  /** `createRequestBudget`, with the storage that keeps its state. */
  createRequestBudget(options: { storage: ReturnType<typeof checkpointStorage> }): PlatformBudget
  /** `createNodeTransport`: Node's `fetch` (or `fetch`), with a browser User-Agent. */
  createNodeTransport(options: {
    budget: PlatformBudget
    userAgent?: string
    fetch?: typeof fetch
  }): { withPriority(priority: 'bulk'): typeof fetch }
}

/** Where `@fxm/platform`'s entry point is, next to this package in the workspace. */
export const PLATFORM_ENTRY = new URL('../../../platform/src/index.ts', import.meta.url)

/** Loads `@fxm/platform` (Node, through Vitest, which compiles its TypeScript). */
export async function loadPlatform(): Promise<PlatformModule> {
  return (await import(/* @vite-ignore */ PLATFORM_ENTRY.href)) as PlatformModule
}

/** What {@link recorderNetwork} builds. */
export interface RecorderNetwork {
  /** The device's one request budget, its state kept in the checkpoint. */
  budget: PlatformBudget
  /** The transport's `bulk` fetch, which draws a budget slot for every InnerTube call. */
  fetch: typeof fetch
}

/**
 * The budget and the bulk fetch of a recording run. The budget keeps its state (the hour's calls,
 * a bot-check pause) in `checkpoint.budget`, so it reaches disk with the checkpoint and a resumed
 * run honours it.
 */
export function recorderNetwork(
  platform: PlatformModule,
  checkpoint: EvalCheckpoint,
  options: { userAgent?: string; fetch?: typeof fetch } = {},
): RecorderNetwork {
  const budget = platform.createRequestBudget({ storage: checkpointStorage(checkpoint) })
  const transport = platform.createNodeTransport({ budget, ...options })
  return { budget, fetch: transport.withPriority('bulk') }
}
