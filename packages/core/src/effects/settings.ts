/**
 * The audio effects settings as one value: the equalizer, loudness normalization, crossfade and
 * playback speed. The app stores it and hands it to the player (`Player.setAudioEffects` in
 * `@fxm/player`); validate stored copies with {@link sanitizeAudioEffects}.
 *
 * @module
 */

import { DEFAULT_EQUALIZER, type EqualizerSettings, sanitizeEqualizer } from './equalizer'
import { ownFields } from './fields'
import { DEFAULT_LOUDNESS, type LoudnessSettings, sanitizeLoudness } from './loudness'

/** The longest crossfade, in milliseconds. */
export const MAX_CROSSFADE_MS = 12_000

/** The step the crossfade's length moves in, in milliseconds. */
export const CROSSFADE_STEP_MS = 1000

/**
 * Crossfade: the next track starts this long before the current one ends, and they fade into
 * each other. Only when a track plays to its end and the next one follows by itself: a skip, a
 * repeated track or the end of the queue cut as before.
 */
export interface CrossfadeSettings {
  /** How long the two tracks overlap, in milliseconds; 0 turns crossfade off (the default). */
  readonly durationMs: number
  /**
   * Whether to crossfade between tracks of the same album too. Off by default, so albums that
   * run from one track into the next (live records, classical works, DJ mixes) play gapless.
   */
  readonly sameAlbum: boolean
}

/** Crossfade of a fresh install: off. */
export const DEFAULT_CROSSFADE: CrossfadeSettings = Object.freeze({
  durationMs: 0,
  sameAlbum: false,
})

/** A crossfade length clamped to 0–12 s and rounded to whole seconds; 0 for anything else. */
export function clampCrossfadeMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const clamped = Math.min(MAX_CROSSFADE_MS, Math.max(0, value))
  return Math.round(clamped / CROSSFADE_STEP_MS) * CROSSFADE_STEP_MS
}

/** A valid {@link CrossfadeSettings} from an untrusted value. */
export function sanitizeCrossfade(value: unknown): CrossfadeSettings {
  const stored = ownFields(value)
  const sameAlbum = stored('sameAlbum')
  return {
    durationMs: clampCrossfadeMs(stored('durationMs')),
    sameAlbum: typeof sameAlbum === 'boolean' ? sameAlbum : DEFAULT_CROSSFADE.sameAlbum,
  }
}

/** The slowest playback speed. */
export const MIN_PLAYBACK_RATE = 0.5

/** The fastest playback speed. */
export const MAX_PLAYBACK_RATE = 2

/** The step playback speed moves in. */
export const PLAYBACK_RATE_STEP = 0.05

/** The speeds a quick menu offers. */
export const PLAYBACK_RATE_PRESETS: readonly number[] = Object.freeze([
  0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
])

/**
 * A playback speed clamped to 0.5–2 and rounded to the step; 1 (normal speed) for anything but a
 * number. Speed never changes the pitch.
 */
export function clampPlaybackRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  const clamped = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, value))
  const stepped = Math.round(clamped / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP
  // Two decimals, so 1.1 is 1.1 and not 1.1000000000000001.
  return Math.round(stepped * 100) / 100
}

/** Every audio effect setting. */
export interface AudioEffectsSettings {
  /** The equalizer. */
  readonly equalizer: EqualizerSettings
  /** Loudness normalization. */
  readonly loudness: LoudnessSettings
  /** Crossfade. */
  readonly crossfade: CrossfadeSettings
  /** Playback speed, 1 being normal; the pitch stays. */
  readonly playbackRate: number
}

/**
 * The effects of a fresh install: the equalizer off and flat, loudness normalization on at -14
 * LUFS, no crossfade, normal speed.
 */
export const DEFAULT_AUDIO_EFFECTS: AudioEffectsSettings = Object.freeze({
  equalizer: DEFAULT_EQUALIZER,
  loudness: DEFAULT_LOUDNESS,
  crossfade: DEFAULT_CROSSFADE,
  playbackRate: 1,
})

/**
 * A valid {@link AudioEffectsSettings} from an untrusted value, such as settings read from
 * storage: each part is validated on its own, so a broken equalizer doesn't reset the rest.
 */
export function sanitizeAudioEffects(value: unknown): AudioEffectsSettings {
  const stored = ownFields(value)
  return {
    equalizer: sanitizeEqualizer(stored('equalizer')),
    loudness: sanitizeLoudness(stored('loudness')),
    crossfade: sanitizeCrossfade(stored('crossfade')),
    playbackRate: clampPlaybackRate(stored('playbackRate')),
  }
}

/**
 * The gains of an equal-power crossfade `progress` of the way through (0 to 1): the outgoing
 * track at `cos(p·π/2)`, the incoming one at `sin(p·π/2)`. Their powers add up to 1, so two
 * unrelated songs keep their loudness through the fade.
 */
export function crossfadeGains(progress: number): { readonly out: number; readonly in: number } {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1
  const angle = (p * Math.PI) / 2
  // Exact at the ends, where cos(π/2) would leave 6e-17.
  return { out: p >= 1 ? 0 : Math.cos(angle), in: p >= 1 ? 1 : Math.sin(angle) }
}
