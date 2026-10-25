/**
 * Plain sentences for the connection's state: the tier and why, as the onboarding page and
 * Settings → Diagnostics show them.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import { type ConnectStatus, MIN_CONNECT_VERSION } from '@fxm/platform'
import type { ConnectionState, LiteStatus } from './connection'
import { type Tier, tierOf } from './tiers'

/** The tier of a connection state. */
export function connectionTier(state: Pick<ConnectionState, 'capabilities'>): Tier {
  return tierOf(state.capabilities)
}

/** Whether FXM still works out what this device can reach. */
export function isDetecting(state: Pick<ConnectionState, 'phase'>): boolean {
  return state.phase === 'idle' || state.phase === 'detecting'
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

/** One sentence on the Lite tier, or nothing when it doesn't matter. */
export function describeLite(lite: LiteStatus): string | undefined {
  switch (lite) {
    case 'not-needed':
      return undefined
    case 'passed':
      return "Lite's check passed: YouTube Music answers this browser without an install."
    case 'failed':
      return "Lite's check didn't pass in this browser, so YouTube Music needs FXM Connect here."
    case 'switched-off':
      return 'Lite is switched off for everyone at the moment.'
    case 'checking':
      return 'Checking whether Lite works in this browser…'
    case 'unavailable':
      return "Lite isn't available here."
  }
}

/** The app's name on each platform. */
const APP_NAMES = { desktop: 'desktop app', android: 'Android app' } as const

/** Why the device is in its tier, as a few sentences. */
export function explainConnection(state: ConnectionState): string[] {
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
  const lines = [describeConnect(state.connect), describeLite(state.lite)]
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
