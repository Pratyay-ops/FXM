/**
 * Where Settings → About's "Third-party notices" leads (stage 6.6). The web app links the
 * website's notices, which make dist writes for the code it deploys (`LEGAL_LINKS`). The Android
 * app shows its own copy on a page of the app ({@link NOTICES_ROUTE}): every release APK carries
 * the notices of what it bundles, the Android shell's libraries and the web app's packages, as
 * `third-party-notices.txt` in its web folder (apps/mobile/scripts/notices.ts). A link to the
 * website would show only the web app's, and a link to the file itself would replace the app in
 * its WebView, which stops the music.
 *
 * @module
 */

import { detectEnvironment, type Environment } from '@fxm/platform'

/** The page that shows the Android app's own notices. */
export const NOTICES_ROUTE = '/settings/notices'

/** The notices file in the Android app's web folder (`assets/public/` in the APK). */
export const BUNDLED_NOTICES_FILE = 'third-party-notices.txt'

/** The file's first line (`NOTICES_TITLE` in apps/mobile/scripts/notices.ts). */
export const BUNDLED_NOTICES_TITLE = 'FXM for Android: third-party notices'

function currentEnvironment(): Environment | undefined {
  try {
    return detectEnvironment()
  } catch {
    return undefined
  }
}

/** Whether this build shows the notices it carries, rather than the website's: the Android app. */
export function showsBundledNotices(environment = currentEnvironment()): boolean {
  return environment === 'capacitor'
}

/**
 * The notices this build carries, from its own web folder (the APK, not the network). Rejects
 * when it carries none, as debug builds (`make apk`) don't: the app's server may then answer with
 * the app's page, which isn't the notices either.
 */
export async function fetchBundledNotices(
  fetcher: typeof fetch = globalThis.fetch,
  base: string = import.meta.env.BASE_URL,
): Promise<string> {
  const response = await fetcher(`${base}${BUNDLED_NOTICES_FILE}`, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`No third-party notices in this build (HTTP ${response.status})`)
  }
  const text = await response.text()
  if (!text.startsWith(BUNDLED_NOTICES_TITLE)) {
    throw new Error('No third-party notices in this build')
  }
  return text
}
