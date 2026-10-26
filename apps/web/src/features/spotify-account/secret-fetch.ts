/**
 * How the web app reads Spotify's TOTP secret, which the Spotify provider needs for every token,
 * the account's too. The secret's community sources (GitHub's raw-file hosts) aren't in the
 * app's content security policy: in a browser the secret goes through the Lite tier's sandboxed
 * user-host document (stage 1.10), GET only and size-capped. `make dev`, which doesn't serve that
 * document and has no policy, fetches it directly. The composition root (stage 2.9) and the
 * account feature share this one module.
 *
 * @module
 */

import { type Fetch, FxmError } from '@fxm/core'
import type { FxmPlatform, SandboxTransport } from '@fxm/platform'

/** Fetches from a host through the sandboxed user-host document: GET only, no headers. */
export type UserHostFetch = (
  url: string,
  init: { method: 'GET'; signal?: AbortSignal },
) => Promise<Response>

/**
 * A `fetch` for the secret's sources only: through `userHost` when given, else `direct`
 * without credentials. Any other host is refused.
 */
export function createSecretFetch(options: {
  readonly hosts: readonly string[]
  readonly userHost?: UserHostFetch
  readonly direct?: Fetch
}): Fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.protocol !== 'https:' || !options.hosts.includes(url.hostname)) {
      throw new FxmError('Unsupported', `FXM doesn't read Spotify's secret from ${url.hostname}`)
    }
    const signal = init?.signal ?? undefined
    if (options.userHost) {
      return options.userHost(url.href, { method: 'GET', ...(signal ? { signal } : {}) })
    }
    if (options.direct) {
      return options.direct(url.href, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      })
    }
    throw new FxmError('Unsupported', "FXM can't read Spotify's secret here")
  }
}

/** The user-host document of `sandbox`, or of the platform's own sandbox, if there is one. */
export function userHostOf(
  platform: Pick<FxmPlatform, 'lite'>,
  sandbox?: SandboxTransport,
): UserHostFetch | undefined {
  const documents = sandbox ?? platform.lite?.sandbox
  return documents?.userHost?.bind(documents)
}

/**
 * The secret's `fetch` on `platform` in a browser (see {@link createSecretFetch}), or `undefined`
 * outside one, where the platform's own transport reaches the secret's hosts.
 */
export function secretFetchFor(
  platform: Pick<FxmPlatform, 'environment' | 'lite'>,
  hosts: readonly string[],
  sandbox?: SandboxTransport,
): Fetch | undefined {
  if (platform.environment !== 'browser') return undefined
  // `make dev` only (Vite's development mode; tests run in mode `test` and use the document).
  if (import.meta.env.DEV && import.meta.env.MODE === 'development') {
    return createSecretFetch({ hosts, direct: globalThis.fetch.bind(globalThis) })
  }
  const userHost = userHostOf(platform, sandbox)
  return userHost === undefined ? undefined : createSecretFetch({ hosts, userHost })
}
