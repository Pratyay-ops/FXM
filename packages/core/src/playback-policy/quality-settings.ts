/**
 * The quality settings beside the tier ceilings of `QualityPrefs` (stage 4.3): which
 * connection's ceiling streaming follows, and the data saver. {@link streamingProfile} turns
 * them, with what the platform detects, into what the stream choice needs, and
 * {@link probeChosenStream} is how a resolver probes only the stream that will play, as the data
 * saver asks.
 *
 * @module
 */

import type { StreamOption } from '../providers'
import {
  compareTiers,
  DEFAULT_QUALITY_PREFS,
  isQualityTier,
  type QualityPrefs,
  type QualityTier,
} from '../quality'

/**
 * The two connections streaming quality tells apart, named as in `QualityPrefs.streaming`:
 * `wifi` for Wi-Fi and Ethernet, `cellular` for mobile data.
 */
export type ConnectionKind = 'wifi' | 'cellular'

/**
 * What the platform says about the current connection: `wifi` (Wi-Fi or Ethernet), `cellular`
 * (mobile data), or `unknown`. Most desktop browsers, Safari and Firefox can't tell, and other
 * connection types (Bluetooth, none, `other`) are `unknown` too.
 */
export type DetectedConnection = ConnectionKind | 'unknown'

/**
 * The connection a Network Information API type names (`navigator.connection.type`, reported by
 * Chromium on Android and ChromeOS and by Android's WebView): `wifi` and `ethernet` are `wifi`,
 * `cellular` is `cellular`, and anything else is `unknown`, a missing type included. The stream
 * lifecycle's browser network monitor counts only `cellular` as mobile data too.
 */
export function connectionFromType(type: unknown): DetectedConnection {
  if (type === 'cellular') return 'cellular'
  if (type === 'wifi' || type === 'ethernet') return 'wifi'
  return 'unknown'
}

/**
 * Which connection's tier ceiling streaming follows:
 *
 * - `auto`: the one the platform detects, and the Wi-Fi ceiling when it can't tell
 * - `wifi`: always the Wi-Fi ceiling
 * - `cellular`: always the mobile-data ceiling, e.g. for a laptop on a phone's hotspot, which the
 *   laptop sees as Wi-Fi, or in a browser that can't tell
 */
export type ConnectionPreference = 'auto' | ConnectionKind

/** Every {@link ConnectionPreference}, `auto` first. */
export const CONNECTION_PREFERENCES: readonly ConnectionPreference[] = Object.freeze([
  'auto',
  'wifi',
  'cellular',
])

/** Whether `value` is a {@link ConnectionPreference}, e.g. to validate a stored setting. */
export function isConnectionPreference(value: unknown): value is ConnectionPreference {
  return typeof value === 'string' && (CONNECTION_PREFERENCES as readonly string[]).includes(value)
}

/**
 * The streaming settings beside the tier ceilings in `QualityPrefs.streaming`. Validate stored
 * copies with {@link sanitizeStreamingSettings}.
 */
export interface StreamingSettings {
  /** Which connection's ceiling streaming follows. */
  connection: ConnectionPreference
  /**
   * The data saver: stream at {@link DATA_SAVER_CEILING} (`low`) on every connection, put
   * audio-only streams before a muxed video everywhere, and ask resolvers to probe only the
   * stream playback chooses (see {@link streamingProfile}). Off by default. Downloads ignore it.
   */
  dataSaver: boolean
}

/**
 * The settings of a fresh install: follow the detected connection, data saver off. Frozen;
 * {@link sanitizeStreamingSettings} gives a mutable copy.
 */
export const DEFAULT_STREAMING_SETTINGS: Readonly<StreamingSettings> = Object.freeze({
  connection: 'auto',
  dataSaver: false,
})

/**
 * Valid {@link StreamingSettings} from an untrusted value, such as settings read from storage or
 * an imported backup. A field that is missing or invalid gets its default from
 * {@link DEFAULT_STREAMING_SETTINGS}, and unknown fields are dropped. Never throws, never reads
 * inherited fields, and returns a fresh, mutable object.
 */
export function sanitizeStreamingSettings(value: unknown): StreamingSettings {
  const stored: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const field = (name: keyof StreamingSettings): unknown =>
    Object.hasOwn(stored, name) ? stored[name] : undefined
  const connection = field('connection')
  const dataSaver = field('dataSaver')
  return {
    connection: isConnectionPreference(connection)
      ? connection
      : DEFAULT_STREAMING_SETTINGS.connection,
    dataSaver: typeof dataSaver === 'boolean' ? dataSaver : DEFAULT_STREAMING_SETTINGS.dataSaver,
  }
}

/** The tier ceiling the data saver streams at, on every connection. */
export const DATA_SAVER_CEILING: QualityTier = 'low'

/**
 * Which stream URLs a resolver probes at the end of their file, where the bytes are readable
 * (FXM Connect, the desktop app, the Android app; see `FullLengthCheck`):
 *
 * - `default`: those the source probes by default. The YouTube ladder (1.4) probes the best URL
 *   of each codec and media (Opus 251, AAC 140, itag 18), and the next one of that codec while
 *   one is capped: two ranged GETs on VISIONOS. Caps belong to a client, not a format, so that
 *   tells whether the rung's URLs play to the end
 * - `chosen`: only the URL playback would choose, and the next choice while a probe finds one
 *   capped (see {@link probeChosenStream}). One end-of-file probe for a rung that isn't capped
 *   (one ranged GET on VISIONOS), on the URL that then plays: what the data saver asks for
 *
 * A request without a scope means `default`.
 */
export type ProbeScope = 'default' | 'chosen'

/** How playback streams on the current connection, as {@link streamingProfile} works it out. */
export interface StreamingProfile {
  /** The connection whose ceiling applies. */
  connection: ConnectionKind
  /**
   * Why that connection: `detected` by the platform, `chosen` by the user, or `assumed` to be
   * Wi-Fi because the platform can't tell.
   */
  basis: 'detected' | 'chosen' | 'assumed'
  /** The highest tier to stream at (a ceiling, see `pickStream`). */
  ceiling: QualityTier
  /**
   * Whether audio-only streams come before a muxed video, even of a higher tier, because the
   * video costs data (see `choosePlaybackStream`).
   */
  preferAudioOnly: boolean
  /** Which URLs the resolvers probe (see {@link ProbeScope}). */
  probe: ProbeScope
}

/** The lower of two tiers. */
function lowerTier(a: QualityTier, b: QualityTier): QualityTier {
  return compareTiers(a, b) >= 0 ? a : b
}

/**
 * How playback streams now, from the user's quality settings and the connection the platform
 * detects:
 *
 * - **The connection** is the one the user chose, else the one detected, else Wi-Fi. Its ceiling
 *   comes from `prefs.streaming`.
 * - **On mobile data**, audio-only streams come before a muxed video (YouTube's itag 18), even of
 *   a higher tier, because the video costs data.
 * - **The data saver** lowers the ceiling to {@link DATA_SAVER_CEILING} on every connection, puts
 *   audio-only streams first everywhere, and asks the resolvers to probe only the `chosen`
 *   stream.
 *
 * Without the data saver, the resolvers probe as they do by `default`. Values that are not what
 * the types say, which only unchecked data holds, fail closed: an unknown connection preference
 * counts as `auto`, an unknown detected connection as `unknown`, an invalid ceiling as the
 * default for its connection, and only `dataSaver: true` turns the data saver on. The stream
 * lifecycle asks for every stream it chooses, so a change applies from the next stream on.
 */
export function streamingProfile(
  prefs: { readonly streaming: Readonly<QualityPrefs['streaming']> },
  settings: Readonly<StreamingSettings>,
  detected: DetectedConnection,
): StreamingProfile {
  let connection: ConnectionKind = 'wifi'
  let basis: StreamingProfile['basis'] = 'assumed'
  if (settings.connection === 'wifi' || settings.connection === 'cellular') {
    connection = settings.connection
    basis = 'chosen'
  } else if (detected === 'wifi' || detected === 'cellular') {
    connection = detected
    basis = 'detected'
  }
  const stored = prefs.streaming[connection]
  const ceiling = isQualityTier(stored) ? stored : DEFAULT_QUALITY_PREFS.streaming[connection]
  if (settings.dataSaver !== true) {
    return {
      connection,
      basis,
      ceiling,
      preferAudioOnly: connection === 'cellular',
      probe: 'default',
    }
  }
  return {
    connection,
    basis,
    ceiling: lowerTier(ceiling, DATA_SAVER_CEILING),
    preferAudioOnly: true,
    probe: 'chosen',
  }
}

/**
 * How a resolver probes the URLs it found, where the bytes are readable. The stream lifecycle
 * passes one with every resolution (`StreamSourceRequest.probe` in `@fxm/player`).
 */
export interface ProbePlan {
  /** The source's `default` probing, or only the `chosen` URL (see {@link ProbeScope}). */
  readonly scope: ProbeScope
  /**
   * The option playback would choose from `options`, or `undefined` when none would do: as
   * `choosePlaybackStream` chooses, with the player's formats, the connection's ceiling, and
   * without the URLs and formats that already failed. It returns one of the options it is given.
   * With a `chosen` scope, pass it to {@link probeChosenStream}.
   */
  choose<T extends StreamOption>(options: readonly T[]): T | undefined
}

/** Why {@link probeChosenStream} stopped (see {@link ChosenProbeResult.outcome}). */
export type ChosenProbeOutcome = 'playable' | 'capped' | 'nothing-chosen'

/** What {@link probeChosenStream} found. */
export interface ChosenProbeResult<T extends StreamOption> {
  /** The options in their order, each probed one replaced by what its probe returned. */
  options: T[]
  /**
   * Why probing stopped, which is how a resolver judges the rung:
   *
   * - `playable`: playback would choose an option that no probe found capped: one whose probe
   *   passed or could not tell, one already `verified`, or one that isn't `progressive`, which an
   *   end-of-file probe doesn't apply to. The rung works
   * - `capped`: a probe found the chosen URL capped, and nothing is left that playback would
   *   choose. Count it like every URL of the rung being capped
   * - `nothing-chosen`: playback would choose nothing before any probe found a cap, e.g. because
   *   the URLs and formats that already failed leave nothing, or the player can play none of
   *   them. That says nothing about caps: never count it against the rung, and judge the rung as
   *   without a plan (the YouTube ladder: capped only when every option is `capped`)
   */
  outcome: ChosenProbeOutcome
}

/**
 * Probes only the option playback would choose, for a `chosen` {@link ProbeScope}: the option
 * `choose` (the plan's) picks, and when its probe finds it `capped`, the option `choose` picks
 * from the rest, and so on, so a capped URL never ends the search. Probing stops at the first
 * option that isn't capped. An option already `verified` is not probed again, one that isn't
 * `progressive` (HLS, DASH, SABR) is not probed at all, since an end-of-file probe reads a file,
 * and the options never chosen stay as they were, usually `unverified`.
 *
 * `probe` returns the option with what its probe found (`fullLength`, and anything else the
 * resolver learned, such as the file's length). It should not reject, since a probe that can't
 * tell is `unverified`; a rejection, such as the caller's cancellation, is passed on.
 */
export async function probeChosenStream<T extends StreamOption>(
  options: readonly T[],
  choose: ProbePlan['choose'],
  probe: (option: T) => Promise<T>,
): Promise<ChosenProbeResult<T>> {
  const result = [...options]
  const done = new Set<number>()
  let foundCap = false
  for (;;) {
    const open = [...result.keys()].filter(
      (index) => !done.has(index) && result[index]?.fullLength !== 'capped',
    )
    const picked = choose(open.map((index) => result[index] as T))
    const index = open.find((candidate) => result[candidate] === picked)
    // Nothing left to choose, or `choose` returned an option it was not given.
    if (picked === undefined || index === undefined) {
      return { options: result, outcome: foundCap ? 'capped' : 'nothing-chosen' }
    }
    done.add(index)
    if (picked.fullLength === 'verified' || picked.protocol !== 'progressive') {
      return { options: result, outcome: 'playable' }
    }
    const probed = await probe(picked)
    result[index] = probed
    if (probed.fullLength !== 'capped') return { options: result, outcome: 'playable' }
    foundCap = true
  }
}
