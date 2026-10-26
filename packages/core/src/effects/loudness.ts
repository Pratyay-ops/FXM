/**
 * Loudness normalization: how loud a stream is ({@link StreamLoudness}, which sources attach to a
 * `StreamOption`), the setting, and the gain that brings a track to the target level
 * ({@link loudnessGainDb}).
 *
 * Where the numbers come from:
 *
 * - **ReplayGain** tags (`REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK` and the album pair), in
 *   local files and downloads: the gain to the ReplayGain reference, which ReplayGain 2.0 sets at
 *   -18 LUFS (EBU R128 measurement), chosen to match ReplayGain 1.0's 89 dB. The peak is the
 *   largest sample, as a linear value (1 = full scale).
 * - **R128** tags in Opus files (`R128_TRACK_GAIN`, `R128_ALBUM_GAIN`, RFC 7845 §5.2.1): a Q7.8
 *   fixed-point gain (the value / 256, in dB) to -23 LUFS, on top of the header's output gain,
 *   which the decoder applies itself. No peak.
 * - **YouTube**: the `/player` response's `loudnessDb` per format, how far the video is above
 *   YouTube's reference playback level, which has been -14 LUFS since 2019. YouTube's own player
 *   turns a video down by that much and never turns one up. No peak. (See the YouTube stream
 *   resolver's clean-room log.)
 *
 * Every source becomes an integrated loudness in LUFS, so one target fits all of them.
 *
 * @module
 */

import { ownFields } from './fields'

/** Where a {@link StreamLoudness} came from. */
export type LoudnessSource = 'replaygain' | 'r128' | 'youtube'

/** Every {@link LoudnessSource}. */
export const LOUDNESS_SOURCES: readonly LoudnessSource[] = Object.freeze([
  'replaygain',
  'r128',
  'youtube',
])

/**
 * How loud a stream is, for loudness normalization: its integrated loudness (ITU-R BS.1770, as
 * EBU R128 measures it) and, when the source knows it, its peak; the same for its album. Sources
 * attach it to a `StreamOption` as `loudness`; validate stored copies with
 * {@link sanitizeStreamLoudness}.
 */
export interface StreamLoudness {
  /** The track's integrated loudness in LUFS, e.g. -9.5 for a loud modern master. */
  readonly trackLufs: number
  /** The track's largest sample, linear (1 is full scale), when known. */
  readonly trackPeak?: number
  /** The album's integrated loudness in LUFS, when known. */
  readonly albumLufs?: number
  /** The album's largest sample, linear, when known. */
  readonly albumPeak?: number
  /** Where the values came from. */
  readonly source: LoudnessSource
}

/** ReplayGain's reference level, in LUFS (ReplayGain 2.0). */
export const REPLAYGAIN_REFERENCE_LUFS = -18

/** The reference level of Opus R128 gain tags, in LUFS (EBU R128). */
export const R128_REFERENCE_LUFS = -23

/** YouTube's reference playback level, in LUFS, which its `loudnessDb` is measured from. */
export const YOUTUBE_REFERENCE_LUFS = -14

/** The quietest and loudest integrated loudness FXM believes, in LUFS. */
const LUFS_RANGE = { min: -70, max: 6 } as const

/** The largest peak FXM believes, linear: true peaks of loud masters reach a little past 1. */
const MAX_PEAK = 4

/** The most a track is turned up, in dB, however quiet it is. */
export const MAX_LOUDNESS_BOOST_DB = 12

/** The most a track is turned down, in dB. */
export const MAX_LOUDNESS_CUT_DB = 30

function isLufs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LUFS_RANGE.min &&
    value <= LUFS_RANGE.max
  )
}

function isPeak(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_PEAK
}

function round(value: number): number {
  return Math.round(value * 100) / 100 + 0
}

/** `loudness` with the optional fields that are valid. */
function build(
  source: LoudnessSource,
  trackLufs: number,
  extras: { trackPeak?: unknown; albumLufs?: unknown; albumPeak?: unknown },
): StreamLoudness | undefined {
  if (!isLufs(trackLufs)) return undefined
  const loudness: {
    trackLufs: number
    trackPeak?: number
    albumLufs?: number
    albumPeak?: number
    source: LoudnessSource
  } = { trackLufs: round(trackLufs), source }
  if (isPeak(extras.trackPeak)) loudness.trackPeak = extras.trackPeak
  if (isLufs(extras.albumLufs)) {
    loudness.albumLufs = round(extras.albumLufs)
    if (isPeak(extras.albumPeak)) loudness.albumPeak = extras.albumPeak
  }
  return loudness
}

/** ReplayGain values as tags give them: gains in dB, peaks linear. */
export interface ReplayGainValues {
  /** `REPLAYGAIN_TRACK_GAIN`, in dB, e.g. -7.89. */
  readonly trackGainDb?: number | undefined
  /** `REPLAYGAIN_TRACK_PEAK`, linear, e.g. 0.988525. */
  readonly trackPeak?: number | undefined
  /** `REPLAYGAIN_ALBUM_GAIN`, in dB. */
  readonly albumGainDb?: number | undefined
  /** `REPLAYGAIN_ALBUM_PEAK`, linear. */
  readonly albumPeak?: number | undefined
}

/**
 * The loudness ReplayGain tags describe, or `undefined` without a valid track gain: a gain of G
 * dB to the reference means the track is at -18 − G LUFS. An album gain without a track gain is
 * not enough: FXM normalizes tracks unless the user picks album mode.
 */
export function loudnessFromReplayGain(values: ReplayGainValues): StreamLoudness | undefined {
  const { trackGainDb, albumGainDb } = values
  if (typeof trackGainDb !== 'number' || !Number.isFinite(trackGainDb)) return undefined
  const albumLufs =
    typeof albumGainDb === 'number' && Number.isFinite(albumGainDb)
      ? REPLAYGAIN_REFERENCE_LUFS - albumGainDb
      : undefined
  return build('replaygain', REPLAYGAIN_REFERENCE_LUFS - trackGainDb, {
    trackPeak: values.trackPeak,
    albumLufs,
    albumPeak: values.albumPeak,
  })
}

/**
 * A ReplayGain gain tag's value in dB, e.g. `-7.89 dB` or `+1.2 dB`; also a bare number. Some
 * taggers write a comma for the decimal point. `undefined` for anything else.
 */
export function parseReplayGainDb(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*(?:db)?\s*$/iu.exec(text)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1].replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

/**
 * An Opus R128 gain tag's value in dB: a signed Q7.8 integer, e.g. `-1280` for -5 dB. `undefined`
 * for anything else, including numbers outside a 16-bit range.
 */
export function parseR128GainDb(text: unknown): number | undefined {
  if (typeof text !== 'string' || !/^\s*[+-]?\d{1,6}\s*$/u.test(text)) return undefined
  const value = Number(text.trim())
  if (!Number.isSafeInteger(value) || value < -32768 || value > 32767) return undefined
  return value / 256
}

/**
 * The loudness Opus R128 tags describe (gains in dB, as {@link parseR128GainDb} reads them), or
 * `undefined` without a track gain: a gain of G dB to -23 LUFS means the track is at -23 − G.
 */
export function loudnessFromR128(values: {
  readonly trackGainDb?: number | undefined
  readonly albumGainDb?: number | undefined
}): StreamLoudness | undefined {
  const { trackGainDb, albumGainDb } = values
  if (typeof trackGainDb !== 'number' || !Number.isFinite(trackGainDb)) return undefined
  const albumLufs =
    typeof albumGainDb === 'number' && Number.isFinite(albumGainDb)
      ? R128_REFERENCE_LUFS - albumGainDb
      : undefined
  return build('r128', R128_REFERENCE_LUFS - trackGainDb, { albumLufs })
}

/**
 * The loudness of a YouTube format from its `loudnessDb` (how far above YouTube's -14 LUFS
 * reference it is), or `undefined` for anything but a finite number.
 */
export function loudnessFromYouTube(loudnessDb: unknown): StreamLoudness | undefined {
  if (typeof loudnessDb !== 'number' || !Number.isFinite(loudnessDb)) return undefined
  return build('youtube', YOUTUBE_REFERENCE_LUFS + loudnessDb, {})
}

/**
 * A valid {@link StreamLoudness} from an untrusted value (a download record, a native entry's
 * data), or `undefined`: only known fields with plausible values are kept.
 */
export function sanitizeStreamLoudness(value: unknown): StreamLoudness | undefined {
  const stored = ownFields(value)
  const source = stored('source')
  const trackLufs = stored('trackLufs')
  if (!(LOUDNESS_SOURCES as readonly unknown[]).includes(source) || !isLufs(trackLufs)) {
    return undefined
  }
  return build(source as LoudnessSource, trackLufs, {
    trackPeak: stored('trackPeak'),
    albumLufs: stored('albumLufs'),
    albumPeak: stored('albumPeak'),
  })
}

/** Which gain normalization uses: the track's, or its album's where known. */
export type LoudnessMode = 'track' | 'album'

/** The target levels Settings offers, in LUFS, loudest first, with their names. */
export const LOUDNESS_TARGETS: readonly { readonly lufs: number; readonly label: string }[] =
  Object.freeze([
    Object.freeze({ lufs: -14, label: 'Normal' }),
    Object.freeze({ lufs: -18, label: 'Quiet' }),
    Object.freeze({ lufs: -23, label: 'Quietest' }),
  ])

/** The loudness setting. Validate stored copies with {@link sanitizeLoudness}. */
export interface LoudnessSettings {
  /** Whether tracks are normalized. On by default. */
  readonly enabled: boolean
  /** The level to bring tracks to, in LUFS: one of {@link LOUDNESS_TARGETS}. */
  readonly targetLufs: number
  /** Track or album gain. */
  readonly mode: LoudnessMode
}

/**
 * Loudness normalization of a fresh install: on, at -14 LUFS (YouTube's own reference, so YouTube
 * songs play as loud as on YouTube), by track.
 */
export const DEFAULT_LOUDNESS: LoudnessSettings = Object.freeze({
  enabled: true,
  targetLufs: -14,
  mode: 'track',
})

/** A valid {@link LoudnessSettings} from an untrusted value: invalid fields get their defaults. */
export function sanitizeLoudness(value: unknown): LoudnessSettings {
  const stored = ownFields(value)
  const enabled = stored('enabled')
  const target = stored('targetLufs')
  const mode = stored('mode')
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_LOUDNESS.enabled,
    targetLufs: LOUDNESS_TARGETS.some((option) => option.lufs === target)
      ? (target as number)
      : DEFAULT_LOUDNESS.targetLufs,
    mode: mode === 'track' || mode === 'album' ? mode : DEFAULT_LOUDNESS.mode,
  }
}

/** What the player can do with a gain. */
export interface LoudnessGainOptions {
  /**
   * Whether it can turn a track up: only where it processes the audio itself (Web Audio on
   * readable bytes). A media element's volume, and the Android player's, only turn down.
   */
  readonly boost: boolean
}

/**
 * The gain, in dB, that brings a track of `loudness` to the setting's target: negative for a loud
 * track, positive for a quiet one, 0 when normalization is off or the loudness is unknown.
 *
 * - **Album mode** uses the album's loudness and peak where known, else the track's.
 * - **Turning up** happens only where the player can boost (`options.boost`) and the peak is
 *   known, and only as far as the peak allows without clipping (ReplayGain's clipping
 *   prevention), at most {@link MAX_LOUDNESS_BOOST_DB}. YouTube and R128 give no peak, so their
 *   quiet tracks stay as they are, as on YouTube.
 * - **Turning down** always applies, at most {@link MAX_LOUDNESS_CUT_DB}.
 *
 * Rounded to a hundredth of a dB.
 */
export function loudnessGainDb(
  loudness: StreamLoudness | undefined,
  settings: LoudnessSettings,
  options: LoudnessGainOptions,
): number {
  if (!settings.enabled || loudness === undefined) return 0
  const album = settings.mode === 'album' && loudness.albumLufs !== undefined
  const lufs = album ? (loudness.albumLufs as number) : loudness.trackLufs
  const peak = album ? loudness.albumPeak : loudness.trackPeak
  let gain = settings.targetLufs - lufs
  if (gain > 0) {
    if (!options.boost || peak === undefined) return 0
    gain = Math.min(gain, -20 * Math.log10(peak), MAX_LOUDNESS_BOOST_DB)
    if (gain <= 0) return 0
  }
  return round(Math.max(gain, -MAX_LOUDNESS_CUT_DB))
}

/** A gain in dB as a linear factor: 0 dB is 1, -6 dB about 0.5. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}
