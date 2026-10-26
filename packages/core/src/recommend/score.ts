/**
 * Scoring pooled songs against the user's taste (ARCHITECTURE.md §13, "Ranking"):
 *
 *     score = affinity + similarity + popularity + novelty − skip penalty − recently-played penalty
 *
 * each term from 0 to 1 and weighed ({@link ScoreWeights}; every shelf has its own weights, see
 * {@link SCORE_PRESETS}):
 *
 * | Term | From 0 to 1 |
 * |---|---|
 * | affinity | How much the user likes the track, its artists and its tags, combined like independent votes: `1 − (1 − track)(1 − 0.8·artist)(1 − 0.4·tags)`. Featured artists count half |
 * | similarity | How strongly the sources suggest it (`PooledSong.similarity`) |
 * | popularity | The source's popularity, 0–100 scaled; 0.5 when unknown |
 * | novelty | 0 for a track the user knows; else 1, less up to half as the user knows the artist |
 * | skip penalty | How much of what the user did with the track (or, at half weight, its main artist) was skipping |
 * | recently-played penalty | `2^(−age / recentHalfLife)`: 1 just after a play, ½ after a day by default |
 *
 * @module
 */

import type { RandomSource } from '../queue/random'
import { compareKeys, type PooledSong } from './pool'
import type { TasteIndex } from './taste'

/** How much each term of the score counts. */
export interface ScoreWeights {
  /** How much the user likes the track, its artists and tags. */
  readonly affinity: number
  /** How strongly the sources suggest it. */
  readonly similarity: number
  /** How popular it is. */
  readonly popularity: number
  /** How new it is to the user. */
  readonly novelty: number
  /** The penalty for skips. */
  readonly skip: number
  /** The penalty for a recent play. */
  readonly recent: number
}

/** The terms of one score, each from 0 to 1, before weighing. */
export interface ScoreTerms {
  readonly affinity: number
  readonly similarity: number
  readonly popularity: number
  readonly novelty: number
  readonly skip: number
  readonly recent: number
}

/** A pooled song with its score. */
export interface ScoredSong {
  /** The song. */
  readonly song: PooledSong
  /** The weighed sum of the terms, plus any jitter. */
  readonly score: number
  /** The terms, for explaining and testing a ranking. */
  readonly terms: ScoreTerms
}

/** The weights when nothing says otherwise: the formula's terms counted equally, roughly. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = Object.freeze({
  affinity: 1,
  similarity: 1,
  popularity: 0.15,
  novelty: 0.25,
  skip: 1,
  recent: 0.75,
})

/**
 * The weights of each kind of list:
 *
 * - `quickPicks`: what to play now, mostly what the user likes, some of it new
 * - `because`: what the sources suggest for one seed, new to the user
 * - `discover`: new songs, preferably by new artists
 * - `mix`: a mix of favourites and similar songs
 * - `radio`: what plays after a seed (endless autoplay, stage 3.4)
 */
export const SCORE_PRESETS = Object.freeze({
  quickPicks: Object.freeze({
    affinity: 1,
    similarity: 0.8,
    popularity: 0.1,
    novelty: 0.15,
    skip: 1,
    recent: 1,
  }),
  because: Object.freeze({
    affinity: 0.4,
    similarity: 1.2,
    popularity: 0.15,
    novelty: 0.4,
    skip: 1,
    recent: 1,
  }),
  discover: Object.freeze({
    affinity: 0.5,
    similarity: 1,
    popularity: 0.2,
    novelty: 1,
    skip: 1,
    recent: 1,
  }),
  mix: Object.freeze({
    affinity: 1,
    similarity: 0.8,
    popularity: 0.1,
    novelty: 0.2,
    skip: 1,
    recent: 0.5,
  }),
  radio: Object.freeze({
    affinity: 0.6,
    similarity: 1.2,
    popularity: 0.1,
    novelty: 0.3,
    skip: 1.2,
    recent: 1,
  }),
} satisfies Record<string, ScoreWeights>)

/** One day, the default half-life of the recently-played penalty. */
export const RECENT_HALF_LIFE_MS = 24 * 60 * 60 * 1000

/** Options for {@link scoreSongs}. */
export interface ScoreOptions {
  /** The weights. Default {@link DEFAULT_SCORE_WEIGHTS}. */
  readonly weights?: Partial<ScoreWeights>
  /** The recently-played penalty halves after this long. Default {@link RECENT_HALF_LIFE_MS}. */
  readonly recentHalfLifeMs?: number
  /**
   * Adds up to ± this much noise to every score, from `random`, so lists change between periods
   * (a day, a week) without changing within one. Default 0.
   */
  readonly jitter?: number
  /** The noise source for `jitter`. Required for any noise; a seeded one keeps it reproducible. */
  readonly random?: RandomSource
  /**
   * The similarity to use instead of the song's own, e.g. only the evidence of one seed. Default:
   * `song.similarity`.
   */
  readonly similarity?: (song: PooledSong) => number
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** The mean of the `count` largest values, 0 for none. */
function topMean(values: readonly number[], count: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, count)
  return top.length === 0 ? 0 : top.reduce((sum, value) => sum + value, 0) / top.length
}

/** The terms of one song's score (see the module documentation). */
export function scoreTerms(
  song: PooledSong,
  taste: TasteIndex,
  options: Pick<ScoreOptions, 'recentHalfLifeMs' | 'similarity'> = {},
): ScoreTerms {
  const track = taste.track(song.keys)
  const trackAffinity = track?.norm ?? 0
  let artistAffinity = 0
  song.artistKeys.forEach((key, index) => {
    const share = index === 0 ? 1 : 0.5
    artistAffinity = Math.max(artistAffinity, (taste.artist(key)?.norm ?? 0) * share)
  })
  const tagAffinity = topMean(
    song.tags.map((tag) => taste.tag(tag)),
    3,
  )
  const affinity = 1 - (1 - trackAffinity) * (1 - 0.8 * artistAffinity) * (1 - 0.4 * tagAffinity)

  const main = taste.artist(song.artistKeys[0])
  const novelty = taste.known(song.keys) ? 0 : 1 - 0.5 * (main?.familiarity ?? 0)
  const skip = Math.max(track?.skipShare ?? 0, 0.5 * (main?.skipShare ?? 0))
  const lastPlayedAt = taste.lastPlayedAt(song.keys)
  const halfLife = options.recentHalfLifeMs ?? RECENT_HALF_LIFE_MS
  const recent =
    lastPlayedAt === undefined ? 0 : 2 ** (-Math.max(0, taste.now - lastPlayedAt) / halfLife)
  const popularity = song.popularity === undefined ? 0.5 : song.popularity / 100
  return {
    affinity: clamp01(affinity),
    similarity: clamp01(options.similarity?.(song) ?? song.similarity),
    popularity: clamp01(popularity),
    novelty: clamp01(novelty),
    skip: clamp01(skip),
    recent: clamp01(recent),
  }
}

/** The weighed sum of `terms`. */
export function weighTerms(terms: ScoreTerms, weights: ScoreWeights): number {
  return (
    weights.affinity * terms.affinity +
    weights.similarity * terms.similarity +
    weights.popularity * terms.popularity +
    weights.novelty * terms.novelty -
    weights.skip * terms.skip -
    weights.recent * terms.recent
  )
}

/** Orders scored songs: highest score first, ties by key, so the order never depends on input. */
export function byScore<T extends { readonly song: PooledSong; readonly score: number }>(
  a: T,
  b: T,
): number {
  return b.score - a.score || compareKeys(a.song.key, b.song.key)
}

/**
 * Scores `songs` against `taste`, best first (ties by key). With `jitter`, the noise is drawn in
 * the order of the songs' keys, so the same songs and the same seeded `random` always give the
 * same scores, in whatever order the songs come.
 */
export function scoreSongs(
  songs: readonly PooledSong[],
  taste: TasteIndex,
  options: ScoreOptions = {},
): ScoredSong[] {
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...options.weights }
  const jitter = Math.max(0, options.jitter ?? 0)
  const noise = new Map<string, number>()
  if (jitter > 0 && options.random !== undefined) {
    const keys = [...new Set(songs.map((song) => song.key))].sort(compareKeys)
    for (const key of keys) {
      const value = options.random()
      noise.set(key, (clamp01(Number.isFinite(value) ? value : 0.5) - 0.5) * 2 * jitter)
    }
  }
  return songs
    .map((song) => {
      const terms = scoreTerms(song, taste, options)
      return { song, terms, score: weighTerms(terms, weights) + (noise.get(song.key) ?? 0) }
    })
    .sort(byScore)
}
