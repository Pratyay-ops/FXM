/**
 * Which browser and system the visitor uses, so the onboarding page leads with the install guide
 * that fits: FXM Connect's Chromium zip, its Firefox add-on, the Android app or, on Apple's
 * phones and in Safari, what works without an install.
 *
 * Only a hint: every guide stays one tap away, and nothing is ever refused because of a guess.
 *
 * @module
 */

/** A browser family, as far as installing FXM Connect goes. */
export type BrowserFamily =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'samsung'
  | 'chromium'
  | 'firefox'
  | 'safari'
  | 'other'

/** An operating system. */
export type DeviceOs = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other'

/** What {@link detectDevice} found. */
export interface DeviceInfo {
  readonly browser: BrowserFamily
  readonly os: DeviceOs
}

/** The parts of `navigator` detection reads. */
export interface NavigatorHints {
  readonly userAgent: string
  /** User-Agent Client Hints, in Chromium browsers. */
  readonly userAgentData?:
    | { readonly brands?: readonly { readonly brand: string }[]; readonly platform?: string }
    | undefined
  /** Tells an iPad that asks for desktop sites apart from a Mac. */
  readonly maxTouchPoints?: number | undefined
  /** Brave adds `navigator.brave`. */
  readonly brave?: unknown
}

function detectOs(hints: NavigatorHints): DeviceOs {
  const ua = hints.userAgent
  // Order matters: Android and ChromeOS also say Linux, iPhones say "like Mac OS X".
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  if (/\bcros\b/i.test(ua)) return 'chromeos'
  if (/windows/i.test(ua)) return 'windows'
  if (/macintosh|mac os x/i.test(ua)) return (hints.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos'
  if (/linux|x11/i.test(ua)) return 'linux'
  const platform = hints.userAgentData?.platform?.toLowerCase() ?? ''
  if (platform === 'windows') return 'windows'
  if (platform === 'macos') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'chrome os' || platform === 'chromeos') return 'chromeos'
  return 'other'
}

function detectBrowser(hints: NavigatorHints): BrowserFamily {
  const ua = hints.userAgent
  const brands = (hints.userAgentData?.brands ?? []).map(({ brand }) => brand.toLowerCase())
  // On iPhone and iPad every browser is Safari's engine underneath, and none takes extensions.
  if (/iphone|ipad|ipod/i.test(ua) || /\b(CriOS|FxiOS|EdgiOS)\b/.test(ua)) return 'safari'
  if (/\bFirefox\//.test(ua)) return 'firefox'
  if (/\bEdg(A|e)?\//.test(ua) || brands.includes('microsoft edge')) return 'edge'
  if (hints.brave !== undefined || brands.includes('brave')) return 'brave'
  if (/\bOPR\//.test(ua) || brands.includes('opera')) return 'opera'
  if (/\bVivaldi\//.test(ua)) return 'vivaldi'
  if (/\bSamsungBrowser\//.test(ua)) return 'samsung'
  if (brands.includes('google chrome')) return 'chrome'
  if (/\bChrome\//.test(ua)) return brands.includes('chromium') ? 'chromium' : 'chrome'
  if (/\bChromium\//.test(ua)) return 'chromium'
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'safari'
  return 'other'
}

/** Detects the browser family and the system from the browser's own hints. */
export function detectDevice(hints: NavigatorHints): DeviceInfo {
  return { browser: detectBrowser(hints), os: detectOs(hints) }
}

/** The visitor's device, from the global `navigator`; `other` everywhere without one. */
export function currentDevice(): DeviceInfo {
  const nav = (globalThis as { navigator?: NavigatorHints }).navigator
  return nav === undefined ? { browser: 'other', os: 'other' } : detectDevice(nav)
}

/** Whether the device is a phone or tablet. */
export function isMobile(device: DeviceInfo): boolean {
  return device.os === 'android' || device.os === 'ios'
}

/** Whether the browser installs Chromium extensions (FXM Connect's zip). */
export function isChromium(browser: BrowserFamily): boolean {
  return (
    browser === 'chrome' ||
    browser === 'edge' ||
    browser === 'brave' ||
    browser === 'opera' ||
    browser === 'vivaldi' ||
    browser === 'chromium'
  )
}

/**
 * The install guides:
 *
 * - `chromium`: FXM Connect's zip, loaded unpacked (Chrome, Brave, Opera, Vivaldi and Edge
 *   until it is on Edge Add-ons);
 * - `firefox`: FXM Connect in Firefox, as a temporary add-on until Mozilla signs it;
 * - `desktop`: the desktop app;
 * - `android`: the Android app (APK), for Chrome on Android;
 * - `apple`: Safari, iPhone and iPad, where FXM Connect can't go.
 */
export type GuideId = 'chromium' | 'firefox' | 'desktop' | 'android' | 'apple'

/** The guide that fits the device best. */
export function recommendedGuide(device: DeviceInfo): GuideId {
  if (device.os === 'ios' || device.browser === 'safari') return 'apple'
  if (device.os === 'android') return 'android'
  if (device.browser === 'firefox') return 'firefox'
  if (isChromium(device.browser)) return 'chromium'
  return 'desktop'
}

/** The address of the browser's extensions page, which pages can't link to. */
export function extensionsPage(browser: BrowserFamily): string {
  switch (browser) {
    case 'edge':
      return 'edge://extensions'
    case 'brave':
      return 'brave://extensions'
    case 'opera':
      return 'opera://extensions'
    case 'vivaldi':
      return 'vivaldi://extensions'
    default:
      return 'chrome://extensions'
  }
}

/** The browser's name, for sentences such as "Open the extensions page of Brave". */
export const BROWSER_NAMES: Readonly<Record<BrowserFamily, string>> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  samsung: 'Samsung Internet',
  chromium: 'Chromium',
  firefox: 'Firefox',
  safari: 'Safari',
  other: 'your browser',
}
