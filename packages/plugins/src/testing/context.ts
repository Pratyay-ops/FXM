/**
 * A provider context for tests.
 *
 * @module
 */

import type { CatalogMode, Fetch, NetworkCapabilities, ProviderContext } from '@fxm/core'

/** The Full tier's capabilities, for test contexts. */
const FULL: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'anonymous',
  mediaBytes: true,
  fileSystem: false,
}

/** A provider context for tests, sending through `fetch`. */
export function testContext(
  fetch: Fetch,
  options: { mode?: CatalogMode; signal?: AbortSignal } = {},
): ProviderContext {
  return {
    fetch,
    platform: 'web',
    capabilities: FULL,
    mode: options.mode ?? 'all',
    locale: 'en-IN',
    region: 'IN',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}
