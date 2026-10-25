/**
 * The settings that change what the playback policy plays, and the rule for when a match may
 * play. The bands are the matching engine's own (`MatchBand`, from `../matching`).
 *
 * @module
 */

import type { MatchBand } from '../matching/types'

/** The settings that change what the playback policy plays. Validate stored copies with {@link sanitizePlaybackSettings}. */
export interface PlaybackSettings {
  /**
   * "Prefer lossless": an Internet Archive or Jamendo copy of the track that the matching engine
   * verified by ISRC, or put in the Auto band, plays before the YouTube song. Off by default:
   * such copies are rare for mainstream music, and Jamendo's API quota, shared by everyone who
   * uses the same `client_id`, allows calls outside explicit Jamendo searches only while this
   * is on.
   */
  preferLossless: boolean
  /**
   * "Play best guesses": Suggest-band matches play without asking, also when a queue reaches
   * them. Off by default, so a guess plays only after an explicit user action and a queue skips
   * it, marked "needs review".
   */
  playBestGuesses: boolean
  /**
   * Whether to try the Invidious instance the user entered, the last resort before
   * "Unavailable". Off by default: it is opt-in, and only works once an instance is set up.
   */
  useInvidious: boolean
}

/** The settings of a fresh install: everything off. Frozen; {@link sanitizePlaybackSettings} gives a mutable copy. */
export const DEFAULT_PLAYBACK_SETTINGS: Readonly<PlaybackSettings> = Object.freeze({
  preferLossless: false,
  playBestGuesses: false,
  useInvidious: false,
})

/**
 * Valid {@link PlaybackSettings} from an untrusted value, such as settings read from storage or
 * an imported backup. A field that is missing or not a boolean gets its default from
 * {@link DEFAULT_PLAYBACK_SETTINGS}, and unknown fields are dropped. Never throws, and returns
 * a fresh, mutable object.
 */
export function sanitizePlaybackSettings(value: unknown): PlaybackSettings {
  const stored: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const flag = (name: keyof PlaybackSettings): boolean => {
    const field = Object.hasOwn(stored, name) ? stored[name] : undefined
    return typeof field === 'boolean' ? field : DEFAULT_PLAYBACK_SETTINGS[name]
  }
  return {
    preferLossless: flag('preferLossless'),
    playBestGuesses: flag('playBestGuesses'),
    useInvidious: flag('useInvidious'),
  }
}

/**
 * What the playback policy looks for when a track has no audio of its own, or when "prefer
 * lossless" is on:
 *
 * - `song`: the song on YouTube Music, for a track from a catalog without audio (Spotify, an
 *   import) or an official music video in Music mode
 * - `lossless`: a lossless copy on Internet Archive or Jamendo
 */
export type MatchTarget = 'song' | 'lossless'

/** What decides whether a match may play now (see {@link mayPlayMatch}). */
export interface MatchPlayFacts {
  /** What the match was looked for as. */
  target: MatchTarget
  /**
   * The match's band, after the user's Auto setting (`effectiveMatchBand`): `auto` plays without
   * asking, `suggest` is a best guess, `none` never plays.
   */
  band: MatchBand
  /** Whether the matching engine verified the candidate by its ISRC (`MatchSignals.isrcVerified`). */
  isrcVerified: boolean
  /**
   * Whether the user pinned the match: their pick in "Not the right version?", or a guess they
   * confirmed. A pin always wins.
   */
  pinned: boolean
  /**
   * Whether the user asked for this item just now: tapped it, jumped to it, went back to it or
   * pressed play on it. Reaching it by itself, when the track before it ended or failed, is not
   * explicit.
   */
  explicit: boolean
  /** The "Play best guesses" setting. */
  playBestGuesses: boolean
}

/**
 * Whether a match may play:
 *
 * - a pin always may: the user chose it
 * - a `none` match never does
 * - a `song` match may in the Auto band, and in the Suggest band only after an explicit user
 *   action or with "Play best guesses" on
 * - a `lossless` match comes before the YouTube song only when it is ISRC-verified or in the
 *   Auto band, explicit or not: otherwise the song plays
 */
export function mayPlayMatch(facts: MatchPlayFacts): boolean {
  if (facts.pinned) return true
  if (facts.band === 'none') return false
  if (facts.band === 'auto') return true
  if (facts.target === 'lossless') return facts.isrcVerified
  return facts.explicit || facts.playBestGuesses
}
