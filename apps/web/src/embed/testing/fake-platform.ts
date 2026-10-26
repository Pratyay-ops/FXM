/**
 * A platform for the embed's unit tests: capabilities a test sets and changes, and a provider
 * context whose `fetch` says which budget priority it was built for, records each call's
 * priority and reaches nothing.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext } from '@fxm/core'
import type { ContextOptions, RequestPriority } from '@fxm/platform'
import type { EmbedPlatform } from '../controller'

/** The tiers, by what the embed can reach in them. */
export const CAPABILITIES = Object.freeze({
  /** Free sources only: no FXM Connect, and Lite's self-test failed or is switched off. */
  free: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  /** The Lite tier. */
  lite: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  /** FXM Connect. */
  full: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
} satisfies Record<string, NetworkCapabilities>)

/** A `fetch` of the fake platform: it rejects every call and says its priority. */
export type FakeFetch = typeof fetch & { readonly priority: RequestPriority }

/** An {@link EmbedPlatform} a test controls. */
export interface FakeEmbedPlatform extends EmbedPlatform {
  /** Changes the capabilities and tells the listeners, as FXM Connect appearing would. */
  setCapabilities(capabilities: NetworkCapabilities): void
  /** Every context built, with the options it was built with. */
  readonly contexts: ContextOptions[]
  /** The budget priority of every `fetch` call, in order. */
  readonly fetched: RequestPriority[]
  /** Whether `dispose` was called. */
  readonly disposed: boolean
}

/** A fake platform in the tier of `capabilities` (Lite by default). */
export function createFakePlatform(
  capabilities: NetworkCapabilities = CAPABILITIES.lite,
): FakeEmbedPlatform {
  let current = capabilities
  let disposed = false
  const listeners = new Set<(capabilities: NetworkCapabilities) => void>()
  const contexts: ContextOptions[] = []
  const fetched: RequestPriority[] = []
  const fetches = new Map<RequestPriority, FakeFetch>()
  const fetchFor = (priority: RequestPriority): FakeFetch => {
    let fetch = fetches.get(priority)
    if (fetch === undefined) {
      const reject = async () => {
        fetched.push(priority)
        throw new Error('The embed tests never reach the network')
      }
      fetch = Object.assign(reject, { priority }) as unknown as FakeFetch
      fetches.set(priority, fetch)
    }
    return fetch
  }
  return {
    capabilities: {
      get current() {
        return current
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    context(options): ProviderContext {
      contexts.push(options)
      return {
        fetch: fetchFor(options.priority),
        platform: 'web',
        capabilities: current,
        mode: options.mode,
      }
    },
    dispose() {
      disposed = true
    },
    setCapabilities(next) {
      current = next
      for (const listener of [...listeners]) listener(next)
    },
    contexts,
    fetched,
    get disposed() {
      return disposed
    },
  }
}

/** The budget priority a context's `fetch` was built for, by the fake platform. */
export function priorityOf(ctx: ProviderContext): RequestPriority | undefined {
  return (ctx.fetch as Partial<FakeFetch>).priority
}
