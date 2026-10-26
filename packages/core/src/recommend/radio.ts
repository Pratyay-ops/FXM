/**
 * Endless autoplay radio (stage 3.4, ARCHITECTURE.md §13 "Autoplay and cold start"): when the
 * queue runs low, it grows with songs like the last few plays, ranked by the engine that ranks
 * Home, so the music goes on for as long as the user likes what comes.
 *
 * | Step | Function |
 * |---|---|
 * | Whether the queue needs more | {@link radioShortfall}: 4 tracks once fewer than 3 remain after the current one |
 * | What it grows from | {@link planRadioSeeds}: the last 5 plays of the listening session that the user didn't skip, each weighed by its age and how much the user likes it |
 * | Which radio to fetch | {@link nextRadioSeed}: one per extension, the heaviest seed whose radio isn't at hand (the app caches each seed's) |
 * | What to add | {@link buildRadioBatch}: what the seeds' radios suggest, pooled, scored with `SCORE_PRESETS.radio`, without songs from the last 50 tracks or the queue, diversified |
 *
 * **Likes and skips retune it** through stage 3.1's affinity, which the app reads afresh for
 * every extension: a play the user skipped seeds nothing, its song and its artist score lower
 * (the skip penalty), and a song or artist they mostly skip never comes; a like makes its song
 * a heavier seed, whose radio counts more and is fetched sooner, and lifts every song by its
 * artist.
 *
 * Everything here is pure and deterministic: the time and the noise are inputs.
 *
 * @module
 */

import type { CatalogMode } from '../mode'
import type { Track } from '../model'
import { hasOwnAudio } from '../playback-policy/order'
import { type QueueState, upcomingQueueItems } from '../queue/queue'
import type { RandomSource } from '../queue/random'
import { tagAffinityKey } from '../signals/keys'
import { DEFAULT_MMR_LAMBDA, DEFAULT_PER_ARTIST_CAP, diversify } from './diversify'
import { filterHistory } from './history'
import { artistKeysOf, recSeedOf, seedArtistKey, seedKey, trackKeys } from './identity'
import { seededRandomFor } from './period'
import { compareKeys, fitsMode, type PooledSong, poolCandidates } from './pool'
import { SCORE_PRESETS, scoreSongs, welcomeSongs } from './score'
import { type PlannedSeed, seedWeight } from './seeds'
import { indexTaste, likedEnough, mostlySkipped, type TasteIndex } from './taste'
import type { RecCandidate, TasteProfile } from './types'

/** How endless radio is tuned. Every value has a default ({@link DEFAULT_RADIO_OPTIONS}). */
export interface RadioOptions {
  /** How many of the latest plays seed the radio. */
  readonly seedPlays: number
  /** The queue grows once fewer tracks than this remain after the current one. */
  readonly minUpcoming: number
  /** How many tracks one extension adds. */
  readonly batchSize: number
  /**
   * No song comes back while it is among this many of the latest plays (distinct tracks, as the
   * history counts them): "no repeats within N tracks".
   */
  readonly noRepeatTracks: number
  /**
   * A pause longer than this between the end of one play and the start of the next ends a
   * listening session: plays before it seed nothing.
   */
  readonly sessionGapMs: number
  /** MMR's trade-off between relevance and variety (1 keeps the ranking). */
  readonly lambda: number
  /** Most tracks per artist in one batch, counting the tracks already up next. */
  readonly perArtistCap: number
  /** Up to ± this much noise on every score, so two extensions from the same plays differ. */
  readonly jitter: number
}

/**
 * How endless radio is tuned unless told otherwise. A batch of 4 keeps the play the previous
 * extension fetched a radio for among the last 5 plays at the next one, when the user plays on
 * without skipping, so every batch after the first blends the radios of two plays or more
 * while each extension fetches only one.
 */
export const DEFAULT_RADIO_OPTIONS: RadioOptions = Object.freeze({
  seedPlays: 5,
  minUpcoming: 3,
  batchSize: 4,
  noRepeatTracks: 50,
  sessionGapMs: 2 * 60 * 60 * 1000,
  lambda: DEFAULT_MMR_LAMBDA,
  perArtistCap: DEFAULT_PER_ARTIST_CAP,
  jitter: 0.05,
})

/** A whole number of at least 0 (or `Infinity` where `infinite` allows it), else `fallback`. */
function count(value: unknown, fallback: number, infinite = false): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return fallback
  if (!Number.isFinite(value)) return infinite ? value : fallback
  return Math.floor(value)
}

/** A finite number of at least 0, else `fallback`. */
function amount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * The options with the defaults filled in. A value that is not a number of at least 0 means
 * the default; counts are rounded down, and `perArtistCap` and `sessionGapMs` may be `Infinity`
 * (no cap, no sessions).
 */
export function resolveRadioOptions(input: Partial<RadioOptions> = {}): RadioOptions {
  const defaults = DEFAULT_RADIO_OPTIONS
  return {
    seedPlays: count(input.seedPlays, defaults.seedPlays),
    minUpcoming: count(input.minUpcoming, defaults.minUpcoming),
    batchSize: count(input.batchSize, defaults.batchSize),
    noRepeatTracks: count(input.noRepeatTracks, defaults.noRepeatTracks),
    sessionGapMs: count(input.sessionGapMs, defaults.sessionGapMs, true),
    lambda: Math.min(1, amount(input.lambda, defaults.lambda)),
    perArtistCap: count(input.perArtistCap, defaults.perArtistCap, true),
    jitter: amount(input.jitter, defaults.jitter),
  }
}

/**
 * How many tracks the radio should add to `queue` now: `batchSize` once fewer than
 * `minUpcoming` tracks remain after the current one, else 0. Always 0 for an empty queue and
 * while repeat is on: a repeating queue never runs out, and the user asked to hear it again.
 */
export function radioShortfall(queue: QueueState, options: Partial<RadioOptions> = {}): number {
  const { minUpcoming, batchSize } = resolveRadioOptions(options)
  if (queue.index < 0 || queue.repeat !== 'off') return 0
  return upcomingQueueItems(queue).length < minUpcoming ? batchSize : 0
}

/** What {@link planRadioSeeds} takes besides the taste. */
export interface RadioSeedInput {
  /** The catalog mode: a seed must fit it. */
  readonly mode: CatalogMode
  /**
   * The track playing now: the newest play, which the history doesn't hold until it ends. It
   * seeds unless the user skips it more than they listen to it.
   */
  readonly current?: Track
  /** Tuning: `seedPlays` and `sessionGapMs`. */
  readonly options?: Partial<RadioOptions>
}

/** How much of its weight a seed loses for each play since it: the 5th play keeps 40 %. */
const RECENCY_STEP = 0.15

/** The least of its weight a seed's age leaves it. */
const MIN_RECENCY = 0.4

/** One play of the listening session, newest first. */
interface SessionPlay {
  readonly track: Track
  /** Whether it is the track playing now. */
  readonly current: boolean
}

/**
 * The plays of the listening session, newest first, one per song: the current track, then the
 * history's plays back to the first pause longer than `gapMs` (measured from the end of a play,
 * so a long track doesn't end the session). Plays without metadata are left out: no radio can
 * start from them.
 */
function sessionPlays(taste: TasteIndex, current: Track | undefined, gapMs: number): SessionPlay[] {
  const plays: SessionPlay[] = []
  const seen = new Set<string>()
  const add = (track: Track, isCurrent: boolean) => {
    const keys = trackKeys(track)
    if (keys.length === 0 || keys.some((key) => seen.has(key))) return
    for (const key of keys) seen.add(key)
    plays.push({ track, current: isCurrent })
  }
  let next = current === undefined ? taste.recent[0]?.playedAt : taste.now
  if (current !== undefined) add(current, true)
  for (const play of taste.recent) {
    const lengthMs = play.track?.durationMs
    const endedAt = play.playedAt + (typeof lengthMs === 'number' && lengthMs > 0 ? lengthMs : 0)
    if (next === undefined || next - endedAt > gapMs) break
    next = play.playedAt
    if (play.track !== undefined) add(play.track, false)
  }
  return plays
}

/**
 * The plays the radio grows from, newest first: the last `seedPlays` (5) plays of the
 * listening session, the current track first, without
 *
 * - a play the user skipped: a played track seeds only when the user likes it enough
 *   (`likedEnough`: at least half a play, more listening than skipping), the current track
 *   unless they skip it more than they listen to it;
 * - a track the catalog mode doesn't let recommendations hold, or by an artist the user mostly
 *   skips;
 * - a second play of one song.
 *
 * When none of them can seed (the user skipped them all), the newest play of the session that
 * can does. Each seed's `weight` is how much the user likes it (`seedWeight`, 0.5 to 1), less
 * 15 % for each play since it, down to 40 % of it: from 0.2 to 1.
 */
export function planRadioSeeds(taste: TasteIndex, input: RadioSeedInput): PlannedSeed[] {
  const { seedPlays, sessionGapMs } = resolveRadioOptions(input.options)
  const { mode } = input
  const seedOf = (play: SessionPlay, age: number): PlannedSeed | undefined => {
    const { track } = play
    if (!fitsMode(track, mode)) return undefined
    const known = taste.track(trackKeys(track))
    if (known !== undefined && (play.current ? known.skips > known.score : !likedEnough(known))) {
      return undefined
    }
    const ref = recSeedOf(track)
    const key = seedKey(ref)
    if (key === undefined || mostlySkipped(taste.artist(seedArtistKey(ref)))) return undefined
    const recency = Math.max(MIN_RECENCY, 1 - RECENCY_STEP * age)
    return {
      key,
      seed: track,
      ref,
      parts: ['radio'],
      purposes: ['radio'],
      weight: recency * seedWeight(taste, ref),
    }
  }
  const session = sessionPlays(taste, input.current, sessionGapMs)
  const seeds = session.slice(0, seedPlays).flatMap((play, age) => seedOf(play, age) ?? [])
  if (seeds.length > 0 || seedPlays === 0) return seeds
  for (const play of session.slice(seedPlays)) {
    const seed = seedOf(play, seedPlays)
    if (seed !== undefined) return [seed]
  }
  return []
}

/**
 * The seed whose radio to fetch now: one per extension, the heaviest of `seeds` whose radio
 * `collected` says isn't at hand (cached), the newest on a tie. `undefined` when every seed's
 * radio is.
 */
export function nextRadioSeed(
  seeds: readonly PlannedSeed[],
  collected: (seed: PlannedSeed) => boolean,
): PlannedSeed | undefined {
  let best: PlannedSeed | undefined
  for (const seed of seeds) {
    if (collected(seed)) continue
    if (best === undefined || seed.weight > best.weight) best = seed
  }
  return best
}

/**
 * Whether a track can play unattended, as a radio's tracks must: a track of a source with audio
 * of its own. A Spotify track plays only through a match to a song, which the queue skips while
 * it waits for the user's review (a Suggest-band match), so the radio leaves Spotify's own
 * suggestions out; they still raise the songs another source suggests too.
 */
export function playsUnattended(track: Pick<Track, 'source'>): boolean {
  return hasOwnAudio(track.source)
}

/** Everything one extension of the queue is built from. */
export interface RadioInput {
  /** The user's taste: the affinity, the recent plays and the onboarding picks. */
  readonly profile: TasteProfile
  /**
   * The profile indexed at `now` (`indexTaste(profile, now)`), when the caller has it already.
   * An index made at another time is not used.
   */
  readonly taste?: TasteIndex
  /** The seeds ({@link planRadioSeeds}). Candidates collected for any other seed count for nothing. */
  readonly seeds: readonly PlannedSeed[]
  /** What the seeds' radios suggest (stage 3.2's collector), fetched now or kept from before. */
  readonly candidates: readonly RecCandidate[]
  /** Every track in the queue: played, playing and up next. None of them comes again. */
  readonly queued?: readonly Track[]
  /**
   * The tracks up next, in order. The batch keeps its distance from them (MMR), and they count
   * toward the per-artist cap.
   */
  readonly upcoming?: readonly Track[]
  /** Keys (`trackKeys`) of songs to leave out, e.g. the radio's songs the user removed from the queue. */
  readonly exclude?: Iterable<string>
  /** Whether a track can play unattended. Default {@link playsUnattended}. */
  readonly playable?: (track: Track) => boolean
  /** The catalog mode. */
  readonly mode: CatalogMode
  /** The time, as epoch milliseconds. */
  readonly now: number
  /** Noise for the scores. Default: a source seeded with `now`, so the batch is reproducible. */
  readonly random?: RandomSource
  /** How many tracks to pick. Default: `batchSize`. */
  readonly count?: number
  /** Tuning. */
  readonly options?: Partial<RadioOptions>
}

/** One track the radio picked. */
export interface RadioPick {
  /** The track to queue. */
  readonly track: Track
  /** Its score in the batch. */
  readonly score: number
  /** The seed whose radio suggested it most strongly. */
  readonly seed: PlannedSeed
}

/** One extension of the queue. */
export interface RadioBatch {
  /** The picks, in the order to queue them. */
  readonly picks: readonly RadioPick[]
  /** Their tracks, in that order. */
  readonly tracks: readonly Track[]
}

/** Most tags a pooled song keeps (as in `pool.ts`). */
const MAX_TAGS = 10

/** A track up next, as a pooled song: what MMR and the per-artist cap compare picks with. */
function queuedSong(track: Track): PooledSong | undefined {
  const keys = trackKeys(track)
  const key = keys[0]
  if (key === undefined) return undefined
  const artists = (Array.isArray(track.artists) ? track.artists : [])
    .map((artist) => artist?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
  const tags = new Set<string>()
  for (const tag of Array.isArray(track.tags) ? track.tags : []) {
    const tagKey = typeof tag === 'string' ? tagAffinityKey(tag) : undefined
    if (tagKey !== undefined) tags.add(tagKey)
  }
  return {
    key,
    keys,
    track,
    title: track.title,
    artists,
    artistKeys: artistKeysOf(artists),
    tags: [...tags].sort(compareKeys).slice(0, MAX_TAGS),
    evidence: [],
    similarity: 0,
  }
}

/**
 * Picks the songs one extension adds, best first:
 *
 * 1. **Pool** the candidates of the seeds' radios (`poolCandidates`), each listing counting as
 *    much as its seed's weight, so songs several plays' radios agree on rise. Candidates of any
 *    other seed are dropped, and so are songs without a track (a search would cost requests)
 *    and tracks that can't play unattended (`playable`).
 * 2. **Score** them with `SCORE_PRESETS.radio`: the similarity counts most, then the user's
 *    affinity for the song, its artists and tags, less the skip penalty and the
 *    recently-played penalty; `jitter` adds a little noise.
 * 3. **Leave out** songs with a score of 0 or less, songs whose track or main artist the user
 *    mostly skips, songs among the last `noRepeatTracks` plays, everything in the queue, and
 *    the `exclude`d songs.
 * 4. **Diversify** with MMR and the per-artist cap, keeping distance from the tracks up next,
 *    which count toward the cap.
 */
export function buildRadioBatch(input: RadioInput): RadioBatch {
  const options = resolveRadioOptions(input.options)
  const { mode, now } = input
  const limit = count(input.count, options.batchSize)
  const taste = input.taste?.now === now ? input.taste : indexTaste(input.profile, now)
  const seeds = new Map(input.seeds.map((seed) => [seed.key, seed]))
  const candidates = input.candidates.filter((candidate) =>
    seeds.has(seedKey(candidate?.seed) ?? ''),
  )
  const pool = poolCandidates(candidates, {
    mode,
    seedWeight: (seed) => seeds.get(seedKey(seed) ?? '')?.weight ?? 0,
  })
  const playable = input.playable ?? playsUnattended
  const songs = pool.songs.filter((song) => song.track !== undefined && playable(song.track))
  const scored = scoreSongs(songs, taste, {
    weights: SCORE_PRESETS.radio,
    jitter: options.jitter,
    random: input.random ?? seededRandomFor('radio', mode, String(now)),
  })
  const exclude = new Set(input.exclude ?? [])
  for (const track of input.queued ?? []) for (const key of trackKeys(track)) exclude.add(key)
  const fresh = filterHistory(welcomeSongs(scored, taste), taste, {
    lastPlays: options.noRepeatTracks,
    exclude,
  })
  const after = (input.upcoming ?? []).flatMap((track) => {
    const song = queuedSong(track)
    return song === undefined ? [] : [{ song }]
  })
  const picked = diversify(fresh, {
    limit,
    lambda: options.lambda,
    perArtistCap: options.perArtistCap,
    after,
  })
  const first = input.seeds[0]
  const picks = picked.flatMap(({ song, score }): RadioPick[] => {
    const seed = seeds.get(song.evidence[0]?.seedKey ?? '') ?? first
    return seed === undefined ? [] : [{ track: song.track as Track, score, seed }]
  })
  return { picks, tracks: picks.map((pick) => pick.track) }
}
