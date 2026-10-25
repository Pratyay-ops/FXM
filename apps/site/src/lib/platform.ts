/**
 * Picks the "Get FXM" card that fits the visitor's device. Used by the script in
 * src/components/GetFxm.astro, which is a progressive enhancement: without it, the
 * Download buttons simply scroll to all three cards.
 */

export type Platform = 'android' | 'ios' | 'chromeos' | 'windows' | 'macos' | 'linux'

/** The cards in the "Get FXM" section; each one has the id `get-<card>`. */
export type DownloadCard = 'web' | 'desktop' | 'android'

export interface DeviceInfo {
  /** navigator.userAgent */
  userAgent: string
  /** navigator.userAgentData.platform, when the browser has it (Chromium only) */
  platformHint?: string | undefined
  /** navigator.maxTouchPoints, which tells an iPad that asks for desktop sites from a Mac */
  maxTouchPoints?: number | undefined
}

const HINTS: Record<string, Platform> = {
  android: 'android',
  ios: 'ios',
  'chrome os': 'chromeos',
  'chromium os': 'chromeos',
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
}

/**
 * Best guess at the operating system, or null when it is unknown. Every browser still
 * names the OS in its user agent, so that comes first; the client hint is a fallback.
 */
export function detectPlatform({
  userAgent,
  platformHint = '',
  maxTouchPoints = 0,
}: DeviceInfo): Platform | null {
  // Order matters: Android and ChromeOS user agents also mention Linux, and iPhone
  // user agents mention Mac OS X.
  if (/android/i.test(userAgent)) return 'android'
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios'
  if (/\bcros\b/i.test(userAgent)) return 'chromeos'
  if (/windows/i.test(userAgent)) return 'windows'
  if (/macintosh|mac os x/i.test(userAgent)) return maxTouchPoints > 1 ? 'ios' : 'macos'
  if (/linux|x11/i.test(userAgent)) return 'linux'
  return HINTS[platformHint.trim().toLowerCase()] ?? null
}

/** Which apps are out: AVAILABLE in src/config.ts. */
export interface ReleasedApps {
  desktop: boolean
  android: boolean
}

/**
 * The card to suggest, or null to leave all three to the visitor. Only released apps
 * are suggested, so nobody is sent to a "Coming soon" card:
 *
 * - Computers get the desktop app once it is out, and the web app with FXM Connect
 *   (Chrome, Edge or Brave on a computer) until then. Chromebooks always get the web app.
 * - Android phones get the APK once it is out, and no suggestion until then: FXM Connect
 *   can't be added to a phone's browser.
 * - iPhone and iPad get no suggestion: there is no app and no FXM Connect for them.
 */
export function cardForPlatform(
  platform: Platform | null,
  released: ReleasedApps,
): DownloadCard | null {
  switch (platform) {
    case 'windows':
    case 'macos':
    case 'linux':
      return released.desktop ? 'desktop' : 'web'
    case 'chromeos':
      return 'web'
    case 'android':
      return released.android ? 'android' : null
    default:
      return null
  }
}
