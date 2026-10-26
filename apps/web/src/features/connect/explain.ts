/**
 * Plain sentences for the connection's state: the tier and why, as the onboarding page and
 * Settings → Diagnostics show them, and how this device gets more, as the notices say it.
 *
 * Everything that says how to get more depends on the device and on what is released
 * (`RELEASED`): the extension where a browser can add it, another browser on a Mac, the Android
 * app on Android once it is out, and nothing to install on iPhone and iPad. Nothing here offers an
 * app that isn't out.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import { type ConnectStatus, MIN_CONNECT_VERSION } from '@fxm/platform'
import { RELEASED } from './config'
import type { ConnectionState, LiteStatus } from './connection'
import { canAddConnect, currentDevice, type DeviceInfo, isMacSafari } from './device'
import { type Tier, tierOf } from './tiers'

/** The tier of a connection state. */
export function connectionTier(state: Pick<ConnectionState, 'capabilities'>): Tier {
  return tierOf(state.capabilities)
}

/**
 * Whether FXM still works out what this device can reach. Once FXM Connect has answered, the
 * page can say so, even while the Lite self-test still runs (`lite: 'checking'`).
 */
export function isDetecting(state: Pick<ConnectionState, 'phase' | 'connect'>): boolean {
  return state.phase === 'idle' || (state.phase === 'detecting' && state.connect === undefined)
}

/** "FXM Connect 0.1.0", or just the name when the version is unknown. */
function named(version: string | undefined): string {
  return version === undefined ? 'FXM Connect' : `FXM Connect ${version}`
}

/** One sentence on FXM Connect, in a browser. */
export function describeConnect(status: ConnectStatus | undefined): string | undefined {
  switch (status?.state) {
    case undefined:
      return undefined
    case 'present':
      return status.features.includes('youtube')
        ? `${named(status.version)} is on in this browser.`
        : `${named(status.version)} is on, but doesn't offer YouTube access.`
    case 'outdated':
      return `${named(status.version)} is too old for this version of FXM, so FXM doesn't use it. FXM needs version ${MIN_CONNECT_VERSION} or later.`
    case 'missing':
      return `FXM Connect worked in this browser before${
        status.lastSeenVersion === undefined ? '' : ` (version ${status.lastSeenVersion})`
      }, but it isn't answering now. It may be turned off, removed or blocked by the browser.`
    case 'absent':
      return "FXM Connect isn't installed in this browser."
  }
}

/** What YouTube Music needs on this device when Lite doesn't work. */
function youTubeWithoutLite(device: DeviceInfo): string {
  if (canAddConnect(device)) return 'YouTube Music needs FXM Connect here'
  if (isMacSafari(device)) return "YouTube Music needs FXM Connect, which Safari can't add"
  if (device.os === 'android' && RELEASED.android) return 'YouTube Music needs the Android app here'
  if (device.os === 'android' || device.os === 'ios') {
    return "YouTube Music isn't available in this browser"
  }
  return 'YouTube Music needs FXM Connect, in Chrome, Edge, Brave or Firefox'
}

/** One sentence on the Lite tier, or nothing when it doesn't matter. */
export function describeLite(
  lite: LiteStatus,
  device: DeviceInfo = currentDevice(),
): string | undefined {
  switch (lite) {
    case 'not-needed':
      return undefined
    case 'passed':
      return "Lite's check passed: YouTube Music answers this browser without an install."
    case 'failed':
      return `Lite's check didn't pass in this browser, so ${youTubeWithoutLite(device)}.`
    case 'switched-off':
      return 'Lite is switched off for everyone at the moment.'
    case 'checking':
      return 'Checking whether Lite works in this browser…'
    case 'unavailable':
      return "Lite isn't available here."
  }
}

/** What FXM Connect would add to this browser, as a sentence's subject. */
export type Wanted = 'youtube-and-spotify' | 'spotify' | 'youtube' | 'youtube-downloads'

const WANTED: Readonly<Record<Wanted, { what: string; need: string }>> = {
  'youtube-and-spotify': { what: 'YouTube Music and Spotify', need: 'need' },
  spotify: { what: 'Spotify', need: 'needs' },
  youtube: { what: 'YouTube Music', need: 'needs' },
  'youtube-downloads': { what: 'downloads of YouTube Music songs', need: 'need' },
}

/** `text` with its first letter capitalized, to start a sentence. */
function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * How this device gets `what` (a phrase such as "YouTube Music"), which `need` FXM Connect, in a
 * sentence or two (see {@link howToGetMore}).
 */
function howToReach(device: DeviceInfo, what: string, need: string): string {
  const Need = `${capitalized(what)} ${need} FXM Connect`
  const desktop = RELEASED.desktop ? ', or use the desktop app' : ''
  if (canAddConnect(device)) return `For ${what}, add the free FXM Connect extension${desktop}.`
  if (isMacSafari(device)) {
    return `${Need}, which Safari can't add. On this Mac, open FXM in Chrome, Edge, Brave or Firefox and add it there${desktop}.`
  }
  if (device.os === 'ios') return `${Need}, which isn't available on iPhone and iPad.`
  if (device.os === 'android') {
    return RELEASED.android
      ? `For ${what}, use the Android app, which has everything built in.`
      : `${Need}, which browsers on Android can't add. The Android app is coming soon.`
  }
  return `For ${what}, add the free FXM Connect extension to Chrome, Edge, Brave or Firefox${desktop}.`
}

/**
 * How this device gets what FXM Connect adds, in a sentence or two: add the extension (or the
 * desktop app, once it is out) on a computer, use another browser on a Mac, the Android app on
 * Android (coming soon until it is out), and on iPhone and iPad there is nothing to install.
 */
export function howToGetMore(device: DeviceInfo, wanted: Wanted): string {
  const { what, need } = WANTED[wanted]
  return howToReach(device, what, need)
}

/** Whether this device can install something that adds YouTube Music and Spotify right now. */
export function canGetMoreHere(device: DeviceInfo): boolean {
  if (device.os === 'android') return RELEASED.android
  return device.os !== 'ios'
}

/**
 * What a button to the onboarding page (`/connect`) says on this device: "Get FXM Connect" on a
 * computer, "Get the Android app" on Android once it is out, and "See your options" where
 * nothing can be installed (iPhone and iPad, Android until then): the page says what works there.
 */
export function getMoreLabel(device: DeviceInfo = currentDevice()): string {
  if (device.os === 'android' && RELEASED.android) return 'Get the Android app'
  return canGetMoreHere(device) ? 'Get FXM Connect' : 'See your options'
}

/**
 * The desktop and Android apps, which need no extension, in one sentence that marks the ones not
 * out yet as coming soon.
 */
export function appsSentence(): string {
  if (RELEASED.desktop && RELEASED.android) {
    return 'The desktop and Android apps need no extension: they have everything built in.'
  }
  if (RELEASED.desktop) {
    return 'The desktop app needs no extension: it has everything built in. The Android app is coming soon.'
  }
  if (RELEASED.android) {
    return 'The Android app needs no extension: it has everything built in. The desktop app is coming soon.'
  }
  return 'The desktop and Android apps, which need no extension, are coming soon.'
}

/** The apps that are out, by name: the desktop app (stage 7.5), the Android app (stage 6.6). */
function releasedApps(): string[] {
  return [
    ...(RELEASED.desktop ? ['the desktop app'] : []),
    ...(RELEASED.android ? ['the Android app'] : []),
  ]
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

/**
 * What reaches everything, for sentences such as "Downloading it needs …": FXM Connect, and the
 * desktop and Android apps once they are out ("FXM Connect, the desktop app or the Android app").
 * Until they are, only FXM Connect, so the app never offers an app that isn't out.
 */
export function connectOrApps(): string {
  return orList(['FXM Connect', ...releasedApps()])
}

/**
 * The same with the extension named in full: "the free FXM Connect browser extension", then "or
 * the desktop and Android apps" once they are out.
 */
export function connectExtensionOrApps(): string {
  const apps = releasedApps()
  if (apps.length === 0) return 'the free FXM Connect browser extension'
  const named = apps.length === 2 ? 'the desktop and Android apps' : (apps[0] as string)
  return `the free FXM Connect browser extension or ${named}`
}

/**
 * How FXM reaches `what` (YouTube Music, Spotify), in a sentence or two: through FXM Connect,
 * and the apps that are out, with the others "coming soon" ({@link appsSentence}'s rule). For a
 * device that may not add FXM Connect, use {@link reachSentence}.
 */
export function appsReachSentence(what: string): string {
  const apps = releasedApps()
  const through = `FXM reaches ${what} through the free FXM Connect browser extension`
  if (apps.length === 2) return `${through}, or through the desktop and Android apps.`
  if (apps.length === 1) {
    const missing = RELEASED.desktop ? 'The Android app' : 'The desktop app'
    return `${through}, or through ${apps[0]}. ${missing} is coming soon.`
  }
  return `${through}. The desktop and Android apps are coming soon.`
}

/**
 * How this device reaches `what` (YouTube Music, Spotify), in a sentence or two: where a browser
 * can add FXM Connect, {@link appsReachSentence}; elsewhere what to do instead, as
 * {@link howToGetMore} says it (another browser on a Mac, nothing to install on iPhone and iPad).
 */
export function reachSentence(what: string, device: DeviceInfo = currentDevice()): string {
  return canAddConnect(device) ? appsReachSentence(what) : howToReach(device, what, 'needs')
}

/** The app's name on each platform. */
const APP_NAMES = { desktop: 'desktop app', android: 'Android app' } as const

/** Why the device is in its tier, as a few sentences. */
export function explainConnection(
  state: ConnectionState,
  device: DeviceInfo = currentDevice(),
): string[] {
  if (isDetecting(state)) return ['Checking how FXM can reach music on this device…']
  if (state.phase === 'failed') {
    return ["FXM couldn't check what this device can reach. Reloading the page may help."]
  }
  if (state.platform !== 'web') {
    const app = APP_NAMES[state.platform]
    return tierOf(state.capabilities) === 'full'
      ? [`The ${app} reaches every service directly, with nothing else to install.`]
      : [`This version of the ${app} can't reach YouTube Music or Spotify yet.`]
  }
  const lines = [describeConnect(state.connect), describeLite(state.lite, device)]
  if (state.capabilities.spotify === 'account') {
    lines.push('FXM Connect lets FXM use your Spotify login from this browser.')
  }
  return lines.filter((line): line is string => line !== undefined)
}

/** What the capabilities say about YouTube, for Diagnostics. */
export function describeYouTube(capabilities: NetworkCapabilities): string {
  switch (capabilities.youtube) {
    case 'full':
      return 'Everything: search, playback and reading stream bytes'
    case 'simple':
      return "Search and playback through Lite; stream bytes can't be read"
    case 'none':
      return 'Not reachable'
  }
}

/** What the capabilities say about Spotify, for Diagnostics. */
export function describeSpotify(capabilities: NetworkCapabilities): string {
  switch (capabilities.spotify) {
    case 'account':
      return 'Reachable, with your Spotify login from this browser'
    case 'anonymous':
      return 'Reachable'
    case 'unreachable':
      return 'Not reachable'
  }
}
