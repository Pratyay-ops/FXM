/**
 * The plain-text report that Settings → Diagnostics copies, for a bug report: the app's version,
 * the platform, the system, the browser and its version, the tier, FXM Connect's version and
 * features, each check's result, and the host name of YouTube's audio server.
 *
 * It is built from what the page shows and from googlevideo's host name, never from a URL, so it
 * holds no full URLs, query strings, signatures, IP addresses, tokens or cookies. A last pass
 * ({@link redactReport}) removes anything that looks like one anyway, in case a sentence ever
 * quotes one.
 *
 * @module
 */

import type { Platform } from '@fxm/core'
import {
  type AudioCheckState,
  describeAudioCheck,
  googleVideoHost,
  shownAudioCheck,
} from './audio-check'
import type { ConnectionState } from './connection'
import { type DeviceOs, detectDevice } from './device'
import { budgetSummary, connectSummary, liteSummary, selfTestSummary } from './diagnostics-text'
import { connectionTier, describeSpotify, describeYouTube, isDetecting } from './explain'
import type { SelfTestReport } from './self-test'
import { TIER_INFO } from './tiers'

/** The parts of `navigator` the report reads: the low-entropy hints only. */
export interface ReportNavigator {
  readonly userAgent: string
  /** User-Agent Client Hints, in Chromium browsers. */
  readonly userAgentData?:
    | {
        readonly brands?: readonly { readonly brand: string; readonly version?: string }[]
        readonly platform?: string
      }
    | undefined
  /** Tells an iPad that asks for desktop sites apart from a Mac. */
  readonly maxTouchPoints?: number | undefined
  /** Brave adds `navigator.brave`. */
  readonly brave?: unknown
}

/** Client Hints' made-up brands ("Not A(Brand"), which say nothing about the browser. */
const GREASE_BRAND = /not.?a.?brand/i

/** Browsers by their `User-Agent` token, the more specific first: Edge also says Chrome. */
const USER_AGENT_BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Microsoft Edge'],
  [/\bOPR\/(\d+)/, 'Opera'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\bVivaldi\/(\d+)/, 'Vivaldi'],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/\bCriOS\/(\d+)/, 'Chrome'],
  [/\bChromium\/(\d+)/, 'Chromium'],
  [/\bChrome\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+(?:\.\d+)?)\b.*\bSafari\//, 'Safari'],
]

/** A version as the report shows it: digits and dots only, or nothing. */
function cleanVersion(version: string | undefined): string | undefined {
  return version !== undefined && /^\d{1,5}(?:\.\d{1,5})?$/.test(version) ? version : undefined
}

/**
 * The browser and its major version, e.g. "Microsoft Edge 130": from User-Agent Client Hints'
 * brands where the browser has them, else from the `User-Agent` string.
 */
export function browserLabel(nav: ReportNavigator): string {
  const brands = (nav.userAgentData?.brands ?? []).filter(({ brand }) => !GREASE_BRAND.test(brand))
  const named = brands.find(({ brand }) => brand !== 'Chromium') ?? brands[0]
  if (named !== undefined && /^[\w .-]{1,40}$/.test(named.brand)) {
    const version = cleanVersion(named.version)
    const brand = named.brand === 'Chromium' && nav.brave !== undefined ? 'Brave' : named.brand
    return version === undefined ? brand : `${brand} ${version}`
  }
  for (const [pattern, name] of USER_AGENT_BROWSERS) {
    const match = pattern.exec(nav.userAgent)
    if (match === null) continue
    const brand = name === 'Chrome' && nav.brave !== undefined ? 'Brave' : name
    const version = cleanVersion(match[1])
    return version === undefined ? brand : `${brand} ${version}`
  }
  return 'Unknown'
}

const SYSTEMS: Readonly<Record<DeviceOs, string>> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  android: 'Android',
  ios: 'iOS or iPadOS',
  other: 'Unknown',
}

/** The operating system, without its version. */
export function systemLabel(nav: ReportNavigator): string {
  return SYSTEMS[detectDevice(nav).os]
}

const PLATFORMS: Readonly<Record<Platform, string>> = {
  web: 'Web app, in a browser',
  desktop: 'Desktop app',
  android: 'Android app',
}

/** FXM Connect's features, the protocol's names only. */
function featuresLabel(state: ConnectionState): string {
  const features = (state.connect?.features ?? []).filter((feature) =>
    /^[a-z0-9-]{1,40}$/.test(feature),
  )
  return features.length === 0 ? 'None' : features.join(', ')
}

/** The YouTube audio check, as the page shows it, in a line. */
function audioLine(state: ConnectionState, audio: AudioCheckState): string {
  const shown = shownAudioCheck(state, audio)
  if (shown === 'waiting') return 'Not run (it runs after the song self-test)'
  if (shown === 'checking') return 'Running'
  const text = describeAudioCheck(shown, state.connect?.version)
  return [`${text.title}.`, text.explanation, text.advice].filter(Boolean).join(' ')
}

/** googlevideo's host name, and where a redirect led when the page could follow it. */
function audioServer(audio: AudioCheckState): string | undefined {
  if (audio.phase !== 'done' || !('host' in audio.result)) return undefined
  const result = audio.result
  // Only a host name that is googlevideo's, whatever the result holds.
  const host = googleVideoHost(`https://${result.host}/`)
  if (host === undefined) return undefined
  const to =
    result.kind === 'readable' && result.redirectedTo !== undefined
      ? googleVideoHost(`https://${result.redirectedTo}/`)
      : undefined
  return to === undefined ? host : `${host}, redirected to ${to}`
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const QUERY_PATTERN = /[?&][\w.-]+=\S*/g
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
const IPV6_CANDIDATE = /[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi
const TOKEN_PATTERN = /\b[\w-]{32,}\b/g
const COOKIE_PATTERN = /\b(?:cookie|token|sig|signature|lsig|key)\s*[:=]\s*\S+/gi

/**
 * `text` without anything that looks like a URL, a query string, an IP address, a token, a
 * signature or a cookie. The report never holds one; this keeps it so if a sentence ever quotes
 * one.
 */
export function redactReport(text: string): string {
  return text
    .replace(URL_PATTERN, '[address removed]')
    .replace(QUERY_PATTERN, '[removed]')
    .replace(IPV4_PATTERN, '[IP address removed]')
    .replace(IPV6_CANDIDATE, (match) =>
      // Times such as 10:30 have one colon; an IPv6 address has three or more, or "::".
      match.split(':').length > 3 || match.includes('::') ? '[IP address removed]' : match,
    )
    .replace(COOKIE_PATTERN, '[removed]')
    .replace(TOKEN_PATTERN, '[removed]')
}

/** What {@link diagnosticsReport} reports on. */
export interface DiagnosticsReportInput {
  /** FXM's version (`APP_VERSION`). */
  readonly appVersion: string
  /** The connection's state. */
  readonly state: ConnectionState
  /** The browser's hints. */
  readonly navigator: ReportNavigator
  /** The song self-test: its result once it has one, and whether it runs. */
  readonly selfTest: { readonly report: SelfTestReport | undefined; readonly running: boolean }
  /** The YouTube audio check. */
  readonly audio: AudioCheckState
  /** The time, for the request budget's pause. Default `Date.now()`. */
  readonly now?: number
}

/** The report, one `Name: value` line each. */
export function diagnosticsReport(input: DiagnosticsReportInput): string {
  const { state, audio } = input
  const tier = isDetecting(state) ? 'Checking' : TIER_INFO[connectionTier(state)].name
  const lines: [string, string][] = [
    ['App version', input.appVersion],
    ['Platform', PLATFORMS[state.platform]],
    ['System', systemLabel(input.navigator)],
    ['Browser', browserLabel(input.navigator)],
    ['Tier', tier],
    ['FXM Connect', connectSummary(state.connect, state.platform)],
    ['FXM Connect features', state.platform === 'web' ? featuresLabel(state) : 'Not needed'],
    ['Lite self-test', liteSummary(state.lite, state.platform)],
    ['YouTube', describeYouTube(state.capabilities)],
    ['Spotify', describeSpotify(state.capabilities)],
    ['YouTube requests', budgetSummary(state.budget, input.now)],
    ['Song self-test', selfTestSummary(input.selfTest.report, input.selfTest.running)],
    ['YouTube audio', audioLine(state, audio)],
  ]
  const server = audioServer(audio)
  if (server !== undefined) lines.push(['YouTube audio server', server])
  const text = ['FXM diagnostics', ...lines.map(([name, value]) => `${name}: ${value}`)].join('\n')
  return `${redactReport(text)}\n`
}
