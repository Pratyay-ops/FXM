/**
 * A live check of the Android app's update check against GitHub's API: one request, made the way
 * the app makes it. It runs only with `FXM_LIVE=1` (`make live-smoke`):
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm vitest run apps/web/src/features/app-update/live.test.ts
 * ```
 */

import { describe, expect, it } from 'vitest'
import { webUpdateFetch } from './checks'
import { fetchLatestRelease, parseVersion } from './releases'

/** Node's environment, read without Node's types (the web app type-checks for the browser). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

describe.skipIf(!live)('GitHub releases, live', { timeout: 30_000 }, () => {
  it('reads FXM’s latest release as the Android app does', async () => {
    const release = await fetchLatestRelease(webUpdateFetch)
    // Before FXM's first release, GitHub answers 404 and the check finds nothing.
    if (release !== undefined) {
      expect(parseVersion(release.version)).toBeDefined()
      expect(typeof release.hasApk).toBe('boolean')
    }
  })
})
