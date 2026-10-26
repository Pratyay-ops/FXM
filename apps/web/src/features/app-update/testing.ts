/**
 * Test helpers for the Android app's update check: GitHub's answers and a store of its own.
 *
 * @module
 */

import type { UpdateFetch, UpdateRequestInit } from '@fxm/platform'
import { createAppUpdateStore } from './app-update-store'
import { apkFileName } from './releases'

/** A fake fetch that answers each call with the next response (or error) and records the calls. */
export function fakeUpdateFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: UpdateRequestInit }[] = []
  const fetch: UpdateFetch = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next === undefined) throw new TypeError('Failed to fetch')
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

/** GitHub's answer for a release, trimmed to what the check reads (its shape on 2026-10-26). */
export function releaseAnswer(
  version: string,
  { apk = true, state = 'uploaded' }: { apk?: boolean; state?: string } = {},
) {
  return {
    tag_name: `v${version}`,
    name: `FXM v${version}`,
    html_url: `https://github.com/Pratyay-ops/FXM/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-02T10:00:00Z',
    assets: [
      { name: `fxm-web-${version}.zip`, state: 'uploaded' },
      ...(apk
        ? [
            { name: `fxm-android-arm64-v8a-${version}.apk`, state: 'uploaded' },
            {
              name: apkFileName(version),
              state,
              content_type: 'application/vnd.android.package-archive',
            },
          ]
        : []),
    ],
  }
}

/** A JSON response, as GitHub's API sends it. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** A store of its own, kept in memory. */
export function testAppUpdateStore() {
  const storage = new Map<string, string>()
  return createAppUpdateStore(
    () =>
      ({
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      }) as Storage,
  )
}
