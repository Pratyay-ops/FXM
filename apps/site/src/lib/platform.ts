/**
 * Picks the "Get FXM" card that fits the visitor's device. Used by the only script on
 * the site (src/components/GetFxm.astro), which is a progressive enhancement: without
 * it, the Download buttons simply scroll to all three cards.
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

/**
 * The card to suggest. iPhone and iPad have no FXM app and Chromebooks run the
 * browser extension, so both get the web app.
 */
export function cardForPlatform(platform: Platform | null): DownloadCard | null {
  switch (platform) {
    case 'android':
      return 'android'
    case 'windows':
    case 'macos':
    case 'linux':
      return 'desktop'
    case 'ios':
    case 'chromeos':
      return 'web'
    default:
      return null
  }
}
