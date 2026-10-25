/**
 * Type tests for the platform types of `@fxm/core`. They are checked in three programs, each
 * with one platform library: `tsconfig.dom.json` (browser pages), `tsconfig.worker.json` (web
 * workers, like `@fxm/sources`) and `tsconfig.node.json` (Node). Each program also checks every
 * module in `src` under that library, so core code that only type-checks without a platform
 * library is caught here. `pnpm --filter @fxm/core typecheck` runs them; nothing here runs.
 *
 * @module
 */

import type {
  AbortSignalLike,
  Fetch,
  MinimalAbortSignal,
  MinimalFetch,
  MinimalRequestInit,
  ProviderContext,
} from '../src/providers'
import type { Assert, Equal, Extends } from './assert'

/** `Fetch` is exactly the platform's `fetch`, so the platform's own can be passed as is. */
export type FetchIsPlatformFetch = Assert<Equal<Fetch, typeof fetch>>

/** `AbortSignalLike` is exactly the platform's `AbortSignal`. */
export type SignalIsPlatformSignal = Assert<Equal<AbortSignalLike, AbortSignal>>

/** The platform's `fetch` also satisfies the subset that core falls back to. */
export type PlatformFetchIsMinimal = Assert<Extends<typeof fetch, MinimalFetch>>

/** Every request that the subset allows is a valid platform request. */
export type MinimalInitIsRequestInit = Assert<Extends<MinimalRequestInit, RequestInit>>

/** The platform's `AbortSignal` satisfies the fallback signal. */
export type PlatformSignalIsMinimal = Assert<Extends<AbortSignal, MinimalAbortSignal>>

declare const controller: AbortController
declare const bytes: Uint8Array<ArrayBuffer>

/** A provider context built from the platform's own `fetch` and `AbortSignal`. */
export const context: Pick<ProviderContext, 'fetch' | 'signal'> = {
  fetch: globalThis.fetch.bind(globalThis),
  signal: controller.signal,
}

/** Provider code can send bytes through the injected `fetch` on every platform. */
export function send(ctx: Pick<ProviderContext, 'fetch'>): Promise<unknown> {
  return ctx.fetch('https://example.test/', { method: 'POST', body: bytes })
}
