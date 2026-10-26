/**
 * Time-decayed affinity for tracks, artists and tags, kept incrementally: each listening signal
 * changes the few entries it touches, and nothing is ever recomputed from the whole history.
 *
 * ## The model
 *
 * Every signal contributes a weight `w` at a time `t` (see {@link affinityContributions}). An
 * entry's affinity at time `now` is the sum of its contributions, each halved for every
 * half-life that passed since it was made:
 *
 *     affinity(now) = Σ w · 2^(−(now − t) / halfLife)
 *
 * An entry stores that sum as `score` at its own time `at`, so adding a contribution, reading at
 * any later time and merging two entries are all O(1) (see {@link mergeAffinity}). Contributions
 * may arrive in any order, e.g. an imported history from years ago, and the result is the same.
 * Skips are kept apart, in `skips`, which decays the same way, so the recommendations can weigh
 * them as a penalty of their own.
 *
 * Taking something back (an unlike, a track leaving a playlist) contributes the negative of the
 * original weight at the original time, so it cancels it exactly: the entry ends where it would
 * be had the like never happened. That holds for the artists and tags too as long as the
 * take-back credits the same ones: see {@link reattributeAffinity}.
 *
 * ## Ordering without decaying
 *
 * Every entry decays at the same rate, so their order never changes with time alone:
 * {@link affinityRank} (`log2(score) + at / halfLife`) orders entries by their affinity at any
 * time from their own on. A store can index it and read the top entries without computing a
 * single decay.
 *
 * ## Time never runs backwards
 *
 * No time may lie after the clock of whatever keeps the entries (see `signals.ts`): merging
 * decays everything to the later time, so an entry dated in the future would hold every new
 * contribution at next to nothing until the clock caught up. {@link affinityContributions}
 * refuses such signals when it is told the time, and {@link AffinityIndex} always tells it.
 *
 * @module
 */

import { type EntityId, entityKey, isEntityId } from '../ids'
import { artistAffinityKey, tagAffinityKey, trackAffinityKey } from './keys'
import { ASSUMED_TRACK_MS, playedShare } from './play'
import { isSignalTime, type ListeningSignal, type ListeningSignalTrack } from './signals'

/** The affinity's half-life: a contribution counts half after 14 days, a quarter after 28. */
export const AFFINITY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The version of the scoring model: the half-life, the {@link DEFAULT_AFFINITY_WEIGHTS}, the
 * keys and which artists and tags a signal credits. Stored entries mean something only under
 * the model that built them, so it goes up with every change to any of these, and a store that
 * keeps entries rebuilds them when the version it built them with differs.
 */
export const AFFINITY_MODEL_VERSION = 1

/** Every {@link AffinityKind}. */
export const AFFINITY_KINDS = ['track', 'artist', 'tag'] as const

/** What an affinity entry scores: a track, an artist or a tag. */
export type AffinityKind = (typeof AFFINITY_KINDS)[number]

/** Most IDs an entry keeps: one per source is plenty. */
export const MAX_AFFINITY_IDS = 8

/** Most artists of one track that a signal credits. */
const MAX_SIGNAL_ARTISTS = 8

/** Most tags of one track that a signal credits. */
const MAX_SIGNAL_TAGS = 10

/** Longest label kept. */
const MAX_LABEL_LENGTH = 200

/** Below this, a score or skip count is rounding noise left by cancelled contributions. */
const EPSILON = 1e-9

/**
 * The affinity of one track, artist or tag, as of its time `at`. Plain data: it survives
 * `JSON.stringify`, and a store can keep it as it is.
 *
 * An entry means something only under the half-life and weights that built it: read and merge
 * it with the same ones (see {@link AFFINITY_MODEL_VERSION}).
 */
export interface AffinityEntry {
  /** What it scores. */
  readonly kind: AffinityKind
  /**
   * Its key, unique within its kind: the track's {@link trackAffinityKey}, an
   * {@link artistAffinityKey} or a {@link tagAffinityKey} ({@link affinityKey} makes any of
   * them).
   */
  readonly key: string
  /** What to show: the track's title, the artist's name or the tag, as last spelled. */
  readonly label: string
  /**
   * IDs behind the key, newest first, at most {@link MAX_AFFINITY_IDS}. For a track: its own ID
   * (both YouTube spellings count as one), plus the audio a play actually played when that was
   * another track (a matched song) and the song a music video links, so the recommendations can
   * tell that two track entries are one song. For an artist: its IDs in each source it was seen
   * with. Empty for tags.
   */
  readonly ids: readonly EntityId[]
  /**
   * When `score` and `skips` were last brought up to date, as epoch milliseconds: the latest
   * time of a contribution, never after the clock of whatever keeps the entry.
   */
  readonly at: number
  /**
   * The affinity at `at`: plays, likes and playlist adds, less what unlikes and removals took
   * back, each decayed. Only data that takes back more than it added makes it negative.
   */
  readonly score: number
  /**
   * The skips at `at`, decayed like `score`. Not negative: only {@link reattributeAffinity}
   * takes skips away, and only skips that are there. Reads count rounding below 0 as none.
   */
  readonly skips: number
  /** How many plays it had, all time, without decay. */
  readonly plays: number
  /** When it last started playing, as epoch milliseconds. */
  readonly lastPlayedAt?: number
}

/** One entry with its affinity and skips at a given time. */
export interface AffinityScore {
  /** The entry. */
  readonly entry: AffinityEntry
  /** Its affinity at that time. */
  readonly score: number
  /** Its skips at that time. */
  readonly skips: number
}

/** How much each signal counts. */
export interface AffinityWeights {
  /** A play to the end. A play that stops earlier counts the share of the track it played. */
  readonly play: number
  /** A skip at the very start. A later skip counts the share of the track it left unplayed. */
  readonly skip: number
  /** A like. */
  readonly like: number
  /** A track added to a playlist of the library, Downloads included. */
  readonly playlistAdd: number
  /** The share each credited artist after the first gets; the first gets all of it. */
  readonly featuredArtist: number
}

/**
 * The weights FXM scores signals with. A like says more than one listen, a playlist add a
 * little less than a like, and a featured artist gets half of what the main artist gets.
 */
export const DEFAULT_AFFINITY_WEIGHTS: Readonly<AffinityWeights> = Object.freeze({
  play: 1,
  skip: 1,
  like: 3,
  playlistAdd: 2,
  featuredArtist: 0.5,
})

/** `halfLifeMs`, checked. @throws RangeError when it is not a positive, finite number. */
function checkHalfLife(halfLifeMs: number): number {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) {
    throw new RangeError(`The half-life must be a positive number, not ${halfLifeMs}`)
  }
  return halfLifeMs
}

/**
 * How much a contribution made `elapsedMs` ago still counts: `2^(−elapsed / halfLife)`, so 1 at
 * first, 0.5 after one half-life. Elapsed times that are not positive (a time in the future, or
 * not a number) count as none, so nothing ever grows.
 *
 * @throws RangeError for a half-life that is not a positive, finite number.
 */
export function decayFactor(elapsedMs: number, halfLifeMs: number = AFFINITY_HALF_LIFE_MS): number {
  checkHalfLife(halfLifeMs)
  if (!(elapsedMs > 0)) return 1
  return 2 ** (-elapsedMs / halfLifeMs)
}

/**
 * An entry's affinity and skips at `now` (never grown when `now` is before its time, and skips
 * never below 0).
 */
export function affinityAt(
  entry: AffinityEntry,
  now: number,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): { score: number; skips: number } {
  const fade = decayFactor(now - entry.at, halfLifeMs)
  return { score: entry.score * fade, skips: Math.max(0, entry.skips * fade) }
}

/** An entry with its affinity and skips at `now` (see {@link affinityAt}). */
export function affinityScoreAt(
  entry: AffinityEntry,
  now: number,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): AffinityScore {
  return { entry, ...affinityAt(entry, now, halfLifeMs) }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Orders scores best first: the higher affinity first, then by kind and key, so a list read at
 * one time always comes out in the same order.
 */
export function compareAffinityScores(a: AffinityScore, b: AffinityScore): number {
  return (
    b.score - a.score ||
    compareText(a.entry.kind, b.entry.kind) ||
    compareText(a.entry.key, b.entry.key)
  )
}

/**
 * A number that orders entries by their affinity, highest first, at any time from their own on:
 * `log2(score) + at / halfLife`. It never changes while an entry gets no new contributions,
 * because every entry decays at the same rate, so a store can index it. `-Infinity` for an
 * entry without a positive score.
 */
export function affinityRank(
  entry: AffinityEntry,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): number {
  checkHalfLife(halfLifeMs)
  return entry.score > 0 ? Math.log2(entry.score) + entry.at / halfLifeMs : -Infinity
}

/**
 * Whether an entry holds nothing at all: no affinity, no skips and no plays. A store drops it,
 * e.g. after a like of a track that never played was taken back.
 */
export function isEmptyAffinity(entry: AffinityEntry): boolean {
  return entry.score === 0 && entry.skips === 0 && entry.plays === 0
}

/** The ID a store keeps an entry under: its kind and key, e.g. `artist|radiohead`. */
export function affinityEntryId(kind: AffinityKind, key: string): string {
  return `${kind}|${key}`
}

/**
 * The key of the entry of `kind` that `value` names: a track ID, an artist's name or a tag, or
 * a key made before (each key gives itself back). `undefined` when `value` names nothing that
 * could have an affinity, e.g. "Various Artists".
 */
export function affinityKey(kind: AffinityKind, value: string): string | undefined {
  switch (kind) {
    case 'track':
      return trackAffinityKey(value)
    case 'artist':
      return artistAffinityKey(value)
    case 'tag':
      return tagAffinityKey(value)
    default:
      return undefined
  }
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value
}

/** `newer`'s IDs, then `older`'s it lacks (by `entityKey`), at most {@link MAX_AFFINITY_IDS}. */
function mergeIds(newer: readonly EntityId[], older: readonly EntityId[]): EntityId[] {
  const seen = new Set<string>()
  const ids: EntityId[] = []
  for (const id of [...newer, ...older]) {
    if (ids.length >= MAX_AFFINITY_IDS) break
    const key = entityKey(id)
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(id)
  }
  return ids
}

/**
 * Two entries of the same track, artist or tag as one: their affinities and skips added up,
 * each decayed to the later of their two times, plus their plays. The label is the later
 * entry's, unless it is empty; the IDs are both entries', the later one's first. The order of
 * the arguments matters only for labels and IDs at equal times, where `b` counts as later.
 *
 * Merging is associative and, but for those labels, commutative: merging contributions in any
 * order or grouping gives the same affinity at every time. Sums are exact, so changes that
 * take something away (with negative skips or plays, see {@link reattributeAffinity}) can be
 * merged with each other before they reach the entry they change.
 *
 * Both entries must come from the same half-life and weights.
 *
 * @throws RangeError when the entries are of different kinds or keys, or for a half-life that
 * is not a positive, finite number.
 */
export function mergeAffinity(
  a: AffinityEntry,
  b: AffinityEntry,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): AffinityEntry {
  if (a.kind !== b.kind || a.key !== b.key) {
    throw new RangeError(`Cannot merge ${a.kind} ${a.key} with ${b.kind} ${b.key}`)
  }
  const [older, newer] = b.at >= a.at ? [a, b] : [b, a]
  const fade = decayFactor(newer.at - older.at, halfLifeMs)
  const lastPlayedAt = Math.max(a.lastPlayedAt ?? -Infinity, b.lastPlayedAt ?? -Infinity)
  return {
    kind: a.kind,
    key: a.key,
    label: newer.label === '' ? older.label : newer.label,
    ids: mergeIds(newer.ids, older.ids),
    at: newer.at,
    score: clean(older.score * fade + newer.score),
    skips: clean(older.skips * fade + newer.skips),
    plays: older.plays + newer.plays,
    ...(Number.isFinite(lastPlayedAt) ? { lastPlayedAt } : {}),
  }
}

/** What a signal does to each entry it touches, before the artist shares. */
interface Effect {
  /** When the contribution counts from. */
  at: number
  score: number
  skips: number
  plays: number
  playedAt?: number
}

/** The effect of a signal, or `undefined` for a malformed one. */
function effectOf(signal: ListeningSignal, weights: AffinityWeights): Effect | undefined {
  if (!isSignalTime(signal.at)) return undefined
  switch (signal.type) {
    case 'play': {
      const { playedMs, durationMs } = signal
      if (typeof playedMs !== 'number' || !Number.isFinite(playedMs) || playedMs < 0) {
        return undefined
      }
      if (durationMs !== undefined && !(Number.isFinite(durationMs) && durationMs >= 0)) {
        return undefined
      }
      const share = playedShare(signal, ASSUMED_TRACK_MS)
      const skipped = signal.skipped === true && signal.completed !== true
      return {
        at: signal.at,
        score: weights.play * share,
        skips: skipped ? weights.skip * (1 - share) : 0,
        plays: 1,
        playedAt: signal.at,
      }
    }
    case 'like':
      return { at: signal.at, score: weights.like, skips: 0, plays: 0 }
    case 'unlike':
      return isSignalTime(signal.likedAt)
        ? { at: signal.likedAt, score: -weights.like, skips: 0, plays: 0 }
        : undefined
    case 'playlist-add':
      return { at: signal.at, score: weights.playlistAdd, skips: 0, plays: 0 }
    case 'playlist-remove':
      return isSignalTime(signal.addedAt)
        ? { at: signal.addedAt, score: -weights.playlistAdd, skips: 0, plays: 0 }
        : undefined
    default:
      return undefined
  }
}

function label(text: unknown): string {
  return typeof text === 'string' ? text.trim().slice(0, MAX_LABEL_LENGTH) : ''
}

/** An artist or tag a track's signals credit, with the share of each signal's weight it gets. */
export interface AffinityCredit {
  /** An artist or a tag. */
  readonly kind: 'artist' | 'tag'
  /** Its {@link artistAffinityKey} or {@link tagAffinityKey}. */
  readonly key: string
  /** The name or tag as the track spells it. */
  readonly label: string
  /** The artist's ID in the track's source, when it has one. */
  readonly ids: readonly EntityId[]
  /** The share of each signal's weight: 1 for the first artist and every tag. */
  readonly share: number
}

/**
 * The artists and tags every signal of `track` credits: the first credited artist gets the
 * whole weight and each further one the `featuredArtist` share (at most 8 artists); each tag
 * gets the whole weight (at most 10). Artists and tags are keyed by {@link artistAffinityKey}
 * and {@link tagAffinityKey}, each counted once, and placeholders such as "Various Artists" are
 * left out.
 *
 * A plain video or a podcast episode (`kind` `video` or `episode`) credits nobody: the channel
 * that uploaded a vlog is no artist to recommend from, so such a track counts for itself only.
 * A track of unknown kind, as in an imported history, credits its artists like a song.
 */
export function affinityCredits(
  track: ListeningSignalTrack,
  weights: AffinityWeights = DEFAULT_AFFINITY_WEIGHTS,
): AffinityCredit[] {
  if (track === null || typeof track !== 'object') return []
  if (track.kind === 'video' || track.kind === 'episode') return []
  const credits: AffinityCredit[] = []
  const artists = new Set<string>()
  for (const artist of Array.isArray(track.artists) ? track.artists : []) {
    if (artists.size >= MAX_SIGNAL_ARTISTS) break
    const key = artistAffinityKey(artist?.name)
    if (key === undefined || artists.has(key)) continue
    const share = artists.size === 0 ? 1 : weights.featuredArtist
    artists.add(key)
    const ids = isEntityId(artist.id, 'artist') ? [artist.id] : []
    credits.push({ kind: 'artist', key, label: label(artist.name), ids, share })
  }
  const tags = new Set<string>()
  for (const tag of Array.isArray(track.tags) ? track.tags : []) {
    if (tags.size >= MAX_SIGNAL_TAGS) break
    const key = tagAffinityKey(tag)
    if (key === undefined || tags.has(key)) continue
    tags.add(key)
    credits.push({ kind: 'tag', key, label: label(tag), ids: [], share: 1 })
  }
  return credits
}

/** The IDs a signal's track entry starts with (see {@link AffinityEntry.ids}). */
function trackEntryIds(signal: ListeningSignal): EntityId[] {
  const { track } = signal
  const audioId = signal.type === 'play' ? signal.stream?.audioId : undefined
  const ids: EntityId[] = [track.id]
  for (const id of [audioId, track.songId]) if (isEntityId(id, 'track')) ids.push(id)
  return mergeIds(ids, [])
}

function contribution(
  kind: AffinityKind,
  key: string,
  text: string,
  ids: readonly EntityId[],
  effect: Effect,
  share: number,
): AffinityEntry {
  return {
    kind,
    key,
    label: text,
    ids,
    at: effect.at,
    score: effect.score * share,
    skips: effect.skips * share,
    plays: effect.plays,
    ...(effect.playedAt === undefined ? {} : { lastPlayedAt: effect.playedAt }),
  }
}

/** Options for {@link affinityContributions}. */
export interface AffinityContributionOptions {
  /** How much each signal counts. Default: {@link DEFAULT_AFFINITY_WEIGHTS}. */
  weights?: AffinityWeights
  /**
   * The clock of whatever keeps the affinity, as epoch milliseconds. A signal whose
   * contribution would count from a later time contributes nothing (see the module
   * documentation). Default: no check.
   */
  now?: number
}

/**
 * What one signal contributes to the affinity: an entry for its track and one for each artist
 * and tag it credits ({@link affinityCredits}), each holding the signal's weight at its time:
 *
 * | Signal | Affinity | Skips |
 * |---|---|---|
 * | `play` | `play` × the share played (`playedShare`) | if skipped: `skip` × the share left unplayed |
 * | `like` | `like` | |
 * | `unlike` | `−like` at `likedAt`, cancelling that like | |
 * | `playlist-add` | `playlistAdd` | |
 * | `playlist-remove` | `−playlistAdd` at `addedAt`, cancelling that add | |
 *
 * A play also counts one play, and its start as the last time played. The track entry's IDs
 * are the track's own, the audio a play played when it was another track, and a music video's
 * song.
 *
 * Fails closed: a malformed signal (a time or length that is not a valid number, an invalid
 * track ID) contributes nothing, and so does one dated after `options.now`, so bad data never
 * poisons an entry.
 */
export function affinityContributions(
  signal: ListeningSignal,
  { weights = DEFAULT_AFFINITY_WEIGHTS, now }: AffinityContributionOptions = {},
): AffinityEntry[] {
  const track = signal?.track
  if (track === undefined || track === null || !isEntityId(track.id, 'track')) return []
  const effect = effectOf(signal, weights)
  if (effect === undefined || (now !== undefined && effect.at > now)) return []
  const entries = [
    contribution(
      'track',
      entityKey(track.id),
      label(track.title),
      trackEntryIds(signal),
      effect,
      1,
    ),
  ]
  for (const credit of affinityCredits(track, weights)) {
    entries.push(
      contribution(credit.kind, credit.key, credit.label, credit.ids, effect, credit.share),
    )
  }
  return entries
}

/**
 * What changes when a track's signals stop crediting the artists and tags `from` and credit
 * `to` instead, e.g. because the track's metadata gained a featured artist or its tags: for each
 * artist and tag whose share changes, the track entry's affinity and skips times the change in
 * share, at the track entry's time, and its plays where the credit appears or goes.
 *
 * A track entry holds the sum of everything its signals contributed, and every signal gives its
 * artists and tags the same shares of it, so merging these changes into the artist and tag
 * entries leaves them exactly as if every signal of the track had credited `to` from the start.
 * Only `lastPlayedAt`, which never moves back, and `ids`, which keep what they saw, remember
 * the old credits. A store that keeps the affinity on the latest metadata of each track calls
 * this whenever that metadata changes, so that later take-backs cancel exactly what they take
 * back and a rebuild from the library gives the same numbers.
 */
export function reattributeAffinity(
  track: AffinityEntry,
  from: readonly AffinityCredit[],
  to: readonly AffinityCredit[],
): AffinityEntry[] {
  if (track.kind !== 'track') return []
  const before = new Map(from.map((credit) => [affinityEntryId(credit.kind, credit.key), credit]))
  const after = new Map(to.map((credit) => [affinityEntryId(credit.kind, credit.key), credit]))
  const changes: AffinityEntry[] = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id)
    const next = after.get(id)
    const share = (next?.share ?? 0) - (old?.share ?? 0)
    const plays = (next === undefined ? 0 : track.plays) - (old === undefined ? 0 : track.plays)
    if (share === 0 && plays === 0) continue
    const credit = (next ?? old) as AffinityCredit
    changes.push({
      kind: credit.kind,
      key: credit.key,
      label: next?.label ?? '',
      ids: next?.ids ?? [],
      at: track.at,
      score: track.score * share,
      skips: track.skips * share,
      plays,
      ...(next !== undefined && track.lastPlayedAt !== undefined
        ? { lastPlayedAt: track.lastPlayedAt }
        : {}),
    })
  }
  return changes
}

/** When to read the affinity. */
export interface AffinityReadOptions {
  /** The time to read at, as epoch milliseconds. Default: the reader's clock. */
  now?: number
}

/** Which top entries to read. */
export interface AffinityTopOptions extends AffinityReadOptions {
  /** Most entries to return. Default: 20. */
  limit?: number
}

/**
 * Reads the affinity, wherever it is kept: an {@link AffinityIndex} in memory (its `reader()`)
 * or the web library's table. The recommendations (stages 3.3 and 3.4) read through it, so
 * their tests can run on an index.
 */
export interface AffinityReader {
  /**
   * The entries of `kind` with the highest affinity at `now`, best first (see
   * {@link compareAffinityScores}), at most `limit`. Entries without a positive affinity are
   * left out.
   */
  top(kind: AffinityKind, options?: AffinityTopOptions): Promise<AffinityScore[]>
  /**
   * The affinity at `now` of the entries of `kind` that `values` name, in the same order:
   * track IDs, artist names or tags, or keys made before, which the reader keys itself
   * ({@link affinityKey}). `undefined` where there is none.
   */
  scores(
    kind: AffinityKind,
    values: readonly string[],
    options?: AffinityReadOptions,
  ): Promise<(AffinityScore | undefined)[]>
}

/** Options for an {@link AffinityIndex}. */
export interface AffinityIndexOptions {
  /** How fast affinity fades. Default: {@link AFFINITY_HALF_LIFE_MS} (14 days). */
  halfLifeMs?: number
  /**
   * How much each signal counts; give only what differs. Default:
   * {@link DEFAULT_AFFINITY_WEIGHTS}.
   */
  weights?: Partial<AffinityWeights>
  /**
   * The clock, as epoch milliseconds: signals dated after it are refused, and reads that don't
   * say when read at it. Default: `Date.now`.
   */
  now?: () => number
}

/**
 * The affinity of every track, artist and tag in memory, kept up to date one signal at a time.
 * A store keeps the same entries on disk with {@link affinityContributions} and
 * {@link mergeAffinity}; the index is for computing affinity on the fly and for tests. It
 * refuses signals dated after its clock, and reads at its clock unless told when.
 */
export class AffinityIndex {
  /** How fast affinity fades. */
  readonly halfLifeMs: number
  /** How much each signal counts. */
  readonly weights: Readonly<AffinityWeights>
  readonly #now: () => number
  readonly #entries = new Map<string, AffinityEntry>()

  /** @throws RangeError for a half-life or weight that is not a positive (or zero) number. */
  constructor(options: AffinityIndexOptions = {}) {
    const halfLifeMs = checkHalfLife(options.halfLifeMs ?? AFFINITY_HALF_LIFE_MS)
    const weights = { ...DEFAULT_AFFINITY_WEIGHTS, ...options.weights }
    for (const [name, weight] of Object.entries(weights)) {
      if (!(weight >= 0) || !Number.isFinite(weight)) {
        throw new RangeError(`The ${name} weight must be a number of at least 0, not ${weight}`)
      }
    }
    this.halfLifeMs = halfLifeMs
    this.weights = Object.freeze(weights)
    this.#now = options.now ?? Date.now
  }

  /** How many entries the index holds. */
  get size(): number {
    return this.#entries.size
  }

  /**
   * Applies one signal or many, in any order. Malformed signals change nothing, and neither do
   * signals dated after the clock.
   */
  add(signals: ListeningSignal | Iterable<ListeningSignal>): void {
    const list =
      Symbol.iterator in Object(signals)
        ? (signals as Iterable<ListeningSignal>)
        : [signals as ListeningSignal]
    const now = this.#now()
    for (const signal of list) {
      this.merge(affinityContributions(signal, { weights: this.weights, now }))
    }
  }

  /**
   * Merges entries into the index, e.g. a snapshot read back from storage, or the changes of
   * {@link reattributeAffinity}. They must come from the index's half-life and weights. An
   * entry dated after the clock counts as dated now, which is how it reads anyway, so it
   * cannot hold back what comes after it.
   */
  merge(entries: Iterable<AffinityEntry>): void {
    const now = this.#now()
    for (const entry of entries) {
      const id = affinityEntryId(entry.kind, entry.key)
      const settled = entry.at > now ? { ...entry, at: now } : entry
      const existing = this.#entries.get(id)
      const merged =
        existing === undefined ? settled : mergeAffinity(existing, settled, this.halfLifeMs)
      if (isEmptyAffinity(merged)) this.#entries.delete(id)
      else this.#entries.set(id, merged)
    }
  }

  /** The entry `value` names (a track ID, a name, a tag or a key), as of its own time. */
  get(kind: AffinityKind, value: string): AffinityEntry | undefined {
    const key = affinityKey(kind, value)
    return key === undefined ? undefined : this.#entries.get(affinityEntryId(kind, key))
  }

  /** The affinity at `now` of the entry `value` names; 0 when there is none. */
  score(kind: AffinityKind, value: string, now: number = this.#now()): number {
    const entry = this.get(kind, value)
    return entry === undefined ? 0 : affinityAt(entry, now, this.halfLifeMs).score
  }

  /**
   * The entries `values` name (track IDs, names, tags or keys) with their affinity at `now`, in
   * the same order; `undefined` where there is none.
   */
  scores(
    kind: AffinityKind,
    values: readonly string[],
    now: number = this.#now(),
  ): (AffinityScore | undefined)[] {
    return values.map((value) => {
      const entry = this.get(kind, value)
      return entry === undefined ? undefined : affinityScoreAt(entry, now, this.halfLifeMs)
    })
  }

  /**
   * The entries of `kind` with the highest affinity at `now`, best first, at most `limit` of
   * them. Ties go by key ({@link compareAffinityScores}), so the order is deterministic.
   * Entries without a positive affinity are left out.
   */
  top(
    kind: AffinityKind,
    { limit = 20, now = this.#now() }: AffinityTopOptions = {},
  ): AffinityScore[] {
    const scored: AffinityScore[] = []
    for (const entry of this.#entries.values()) {
      if (entry.kind !== kind) continue
      const score = affinityScoreAt(entry, now, this.halfLifeMs)
      if (score.score > 0) scored.push(score)
    }
    scored.sort(compareAffinityScores)
    return scored.slice(0, Math.max(0, Math.floor(limit)))
  }

  /** Every entry, or every entry of one kind, in no particular order. */
  entries(kind?: AffinityKind): AffinityEntry[] {
    const all = [...this.#entries.values()]
    return kind === undefined ? all : all.filter((entry) => entry.kind === kind)
  }

  /** The index as an {@link AffinityReader}. */
  reader(): AffinityReader {
    return {
      top: async (kind, options) => this.top(kind, options),
      scores: async (kind, values, options) => this.scores(kind, values, options?.now),
    }
  }
}
