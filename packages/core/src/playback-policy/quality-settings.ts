/**
 * The quality settings beside the tier ceilings of `QualityPrefs` (stage 4.3): which
 * connection's ceiling streaming follows, and the data saver. {@link streamingProfile} turns
 * them, with what the platform detects, into what the stream choice needs, and
 * {@link probeStreams} is how a resolver probes only the stream that will play, as the data saver
 * asks.
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
   * audio-only streams before a muxed video everywhere, and have resolvers probe only the stream
   * playback chooses (see {@link streamingProfile}). Off by default. Downloads ignore it.
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
 * How much a resolver probes the stream URLs it found, where the bytes are readable (FXM
 * Connect, the desktop app, the Android app; see `FullLengthCheck`):
 *
 * - `every`: every URL, so that each option says whether it plays to the end
 * - `chosen`: only the URL playback would choose, and the next choice while a probe finds one
 *   capped. One end-of-file probe instead of one per format: what the data saver asks for
 */
export type ProbeScope = 'every' | 'chosen'

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
  /** How much the resolvers probe (see {@link probeStreams}). */
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
 * Every other combination probes `every` URL. Values that are not what the types say, which
 * only unchecked data holds, fail closed: an unknown connection preference counts as `auto`, an
 * unknown detected connection as `unknown`, an invalid ceiling as the default for its connection,
 * and only `dataSaver: true` turns the data saver on. The stream lifecycle asks for every stream
 * it chooses, so a change applies from the next stream on.
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
      probe: 'every',
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
 * passes one with every resolution (`StreamSourceRequest.probe` in `@fxm/player`), and
 * {@link probeStreams} applies it.
 */
export interface ProbePlan {
  /** `every` URL, or only the `chosen` one (see {@link ProbeScope}). */
  readonly scope: ProbeScope
  /**
   * The option playback would choose from `options`, or `undefined` when none would do. It
   * returns one of the options it is given, as `choosePlaybackStream` does with the player's
   * formats, the connection's ceiling and the URLs that already failed.
   */
  choose<T extends StreamOption>(options: readonly T[]): T | undefined
}

/**
 * Probes the options of one resolution as `plan` says, and returns them in their order, each
 * probed option replaced by what `probe` returned for it:
 *
 * - `every`, also without a plan: every option, in parallel
 * - `chosen`: only the option `plan.choose` picks. When its probe finds it `capped`, the option
 *   it picks from the rest, and so on, so a capped URL never ends the search; probing stops at
 *   the first option that is not capped. An option already `verified` is not probed again, and
 *   the options never chosen stay as they were, usually `unverified`
 *
 * `probe` returns the option with what its probe found (`fullLength`, and anything else the
 * resolver learned, such as the file's length). It should not reject, since a probe that can't
 * tell is `unverified`; a rejection, such as the caller's cancellation, is passed on.
 *
 * With `chosen`, a resolver judges the result by `plan.choose(result)`: `undefined` means no
 * option is left that playback would choose, which counts like every URL being capped.
 */
export async function probeStreams<T extends StreamOption>(
  options: readonly T[],
  plan: ProbePlan | undefined,
  probe: (option: T) => Promise<T>,
): Promise<T[]> {
  if (plan?.scope !== 'chosen') return Promise.all(options.map((option) => probe(option)))
  const result = [...options]
  const done = new Set<number>()
  for (;;) {
    const open = result.filter(
      (option, index) => !done.has(index) && option.fullLength !== 'capped',
    )
    const picked = plan.choose(open)
    const index = picked === undefined ? -1 : result.indexOf(picked)
    // Nothing left to choose, or `choose` returned an option it was not given.
    if (picked === undefined || index < 0 || done.has(index)) return result
    done.add(index)
    if (picked.fullLength === 'verified') return result
    const probed = await probe(picked)
    result[index] = probed
    if (probed.fullLength !== 'capped') return result
  }
}
