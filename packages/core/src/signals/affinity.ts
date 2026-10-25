/**
 * Time-decayed affinity for tracks, artists and tags, kept incrementally: each listening signal
 * changes the few entries it touches, and nothing is ever recomputed from the whole history.
 *
 * ## The model
 *
 * Every signal contributes a weight `w` at a time `t` (see {@link signalContributions}). An
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
 * be had the like never happened.
 *
 * ## Ordering without decaying
 *
 * Every entry decays at the same rate, so their order never changes with time alone:
 * {@link affinityRank} (`log2(score) + at / halfLife`) orders entries by their affinity at any
 * time. A store can index it and read the top entries without computing a single decay.
 *
 * @module
 */

import { type EntityId, entityKey, isEntityId } from '../ids'
import { artistAffinityKey, tagAffinityKey } from './keys'
import { ASSUMED_TRACK_MS, playedShare } from './play'
import type { ListeningSignal } from './signals'

/** The affinity's half-life: a contribution counts half after 14 days, a quarter after 28. */
export const AFFINITY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

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

/** Latest time accepted: the largest valid `Date`. */
const MAX_TIME = 8.64e15

/**
 * The affinity of one track, artist or tag, as of its time `at`. Plain data: it survives
 * `JSON.stringify`, and a store can keep it as it is.
 */
export interface AffinityEntry {
  /** What it scores. */
  readonly kind: AffinityKind
  /**
   * Its key: the track's `entityKey`, an {@link artistAffinityKey} or a {@link tagAffinityKey}.
   * Unique within its kind.
   */
  readonly key: string
  /** What to show: the track's title, the artist's name or the tag, as last spelled. */
  readonly label: string
  /**
   * The IDs behind the key, newest first: the track's ID (both YouTube spellings count as one),
   * or the artist's IDs in each source it was seen with. Empty for tags.
   */
  readonly ids: readonly EntityId[]
  /** When `score` and `skips` were last brought up to date, as epoch milliseconds. */
  readonly at: number
  /**
   * The affinity at `at`: plays, likes and playlist adds, less what unlikes and removals took
   * back, each decayed. Only data that takes back more than it added makes it negative.
   */
  readonly score: number
  /** The skips at `at`, decayed like `score`. Never negative. */
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

/**
 * How much a contribution made `elapsedMs` ago still counts: `2^(−elapsed / halfLife)`, so 1 at
 * first, 0.5 after one half-life. Elapsed times that are not positive (a time in the future, or
 * not a number) count as none, so nothing ever grows.
 */
export function decayFactor(elapsedMs: number, halfLifeMs: number = AFFINITY_HALF_LIFE_MS): number {
  if (!(elapsedMs > 0)) return 1
  return 2 ** (-elapsedMs / halfLifeMs)
}

/** An entry's affinity and skips at `now` (never grown when `now` is before its time). */
export function affinityAt(
  entry: AffinityEntry,
  now: number,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): { score: number; skips: number } {
  const fade = decayFactor(now - entry.at, halfLifeMs)
  return { score: entry.score * fade, skips: entry.skips * fade }
}

/**
 * A number that orders entries by their affinity at any time, highest first:
 * `log2(score) + at / halfLife`. It never changes while an entry gets no new contributions,
 * because every entry decays at the same rate, so a store can index it. `-Infinity` for an
 * entry without a positive score.
 */
export function affinityRank(entry: AffinityEntry, halfLifeMs: number = AFFINITY_HALF_LIFE_MS) {
  return entry.score > 0 ? Math.log2(entry.score) + entry.at / halfLifeMs : -Infinity
}

/**
 * Whether an entry holds nothing at all: no affinity, no skips and no plays. A store drops it,
 * e.g. after a like of a track that never played was taken back.
 */
export function isEmptyAffinity(entry: AffinityEntry): boolean {
  return entry.score === 0 && entry.skips === 0 && entry.plays === 0
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
 * order or grouping gives the same affinity at every time.
 *
 * @throws RangeError when the entries are of different kinds or keys.
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
    skips: Math.max(0, clean(older.skips * fade + newer.skips)),
    plays: older.plays + newer.plays,
    ...(Number.isFinite(lastPlayedAt) ? { lastPlayedAt } : {}),
  }
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME
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
  if (!isTime(signal.at)) return undefined
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
      return isTime(signal.likedAt)
        ? { at: signal.likedAt, score: -weights.like, skips: 0, plays: 0 }
        : undefined
    case 'playlist-add':
      return { at: signal.at, score: weights.playlistAdd, skips: 0, plays: 0 }
    case 'playlist-remove':
      return isTime(signal.addedAt)
        ? { at: signal.addedAt, score: -weights.playlistAdd, skips: 0, plays: 0 }
        : undefined
    default:
      return undefined
  }
}

function label(text: unknown): string {
  return typeof text === 'string' ? text.trim().slice(0, MAX_LABEL_LENGTH) : ''
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

/**
 * What one signal contributes to the affinity: an entry for its track, one for each credited
 * artist and one for each tag, each holding the signal's weight at its time:
 *
 * | Signal | Affinity | Skips |
 * |---|---|---|
 * | `play` | `play` × the share played (all of it when completed) | if skipped: `skip` × the share left unplayed |
 * | `like` | `like` | |
 * | `unlike` | `−like` at `likedAt`, cancelling that like | |
 * | `playlist-add` | `playlistAdd` | |
 * | `playlist-remove` | `−playlistAdd` at `addedAt`, cancelling that add | |
 *
 * The track's first credited artist gets the whole weight and each further one the
 * `featuredArtist` share (at most 8 artists); each tag gets the whole weight (at most 10).
 * Artists and tags are keyed by {@link artistAffinityKey} and {@link tagAffinityKey}, each
 * counted once, and placeholders such as "Various Artists" are left out. A play also counts
 * one play, and its start as the last time played.
 *
 * Fails closed: a malformed signal (a time or length that is not a valid number, an invalid
 * track ID) contributes nothing, so bad data can never poison an entry.
 */
export function signalContributions(
  signal: ListeningSignal,
  weights: AffinityWeights = DEFAULT_AFFINITY_WEIGHTS,
): AffinityEntry[] {
  const track = signal?.track
  if (track === undefined || track === null || !isEntityId(track.id, 'track')) return []
  const effect = effectOf(signal, weights)
  if (effect === undefined) return []
  const entries = [
    contribution('track', entityKey(track.id), label(track.title), [track.id], effect, 1),
  ]
  const artists = new Set<string>()
  for (const artist of Array.isArray(track.artists) ? track.artists : []) {
    if (artists.size >= MAX_SIGNAL_ARTISTS) break
    const key = artistAffinityKey(artist?.name)
    if (key === undefined || artists.has(key)) continue
    const share = artists.size === 0 ? 1 : weights.featuredArtist
    artists.add(key)
    const ids = isEntityId(artist.id, 'artist') ? [artist.id] : []
    entries.push(contribution('artist', key, label(artist.name), ids, effect, share))
  }
  const tags = new Set<string>()
  for (const tag of Array.isArray(track.tags) ? track.tags : []) {
    if (tags.size >= MAX_SIGNAL_TAGS) break
    const key = tagAffinityKey(tag)
    if (key === undefined || tags.has(key)) continue
    tags.add(key)
    entries.push(contribution('tag', key, label(tag), [], effect, 1))
  }
  return entries
}

/** Options for an {@link AffinityIndex}. */
export interface AffinityIndexOptions {
  /** How fast affinity fades. Default: {@link AFFINITY_HALF_LIFE_MS} (14 days). */
  halfLifeMs?: number
  /** How much each signal counts; give only what differs. Default: {@link DEFAULT_AFFINITY_WEIGHTS}. */
  weights?: Partial<AffinityWeights>
  /** The clock for reads that don't say when, as epoch milliseconds. Default: `Date.now`. */
  now?: () => number
}

/** The ID of an entry within an index: its kind and key. */
function indexKey(kind: AffinityKind, key: string): string {
  return `${kind}|${key}`
}

/**
 * The affinity of every track, artist and tag in memory, kept up to date one signal at a time.
 * A store keeps the same entries on disk with {@link signalContributions} and
 * {@link mergeAffinity}; the index is for computing affinity on the fly and for tests. Reads use
 * the injected clock unless they say when.
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
    const halfLifeMs = options.halfLifeMs ?? AFFINITY_HALF_LIFE_MS
    if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) {
      throw new RangeError(`The half-life must be a positive number, not ${halfLifeMs}`)
    }
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

  /** Applies one signal or many, in any order. Malformed signals change nothing. */
  add(signals: ListeningSignal | Iterable<ListeningSignal>): void {
    const list =
      Symbol.iterator in Object(signals)
        ? (signals as Iterable<ListeningSignal>)
        : [signals as ListeningSignal]
    for (const signal of list) this.merge(signalContributions(signal, this.weights))
  }

  /** Merges entries into the index, e.g. a snapshot read back from storage. */
  merge(entries: Iterable<AffinityEntry>): void {
    for (const entry of entries) {
      const id = indexKey(entry.kind, entry.key)
      const existing = this.#entries.get(id)
      const merged =
        existing === undefined ? entry : mergeAffinity(existing, entry, this.halfLifeMs)
      if (isEmptyAffinity(merged)) this.#entries.delete(id)
      else this.#entries.set(id, merged)
    }
  }

  /** One entry, as of its own time. */
  get(kind: AffinityKind, key: string): AffinityEntry | undefined {
    return this.#entries.get(indexKey(kind, key))
  }

  /** One entry's affinity at `now`; 0 when there is none. */
  score(kind: AffinityKind, key: string, now: number = this.#now()): number {
    const entry = this.get(kind, key)
    return entry === undefined ? 0 : affinityAt(entry, now, this.halfLifeMs).score
  }

  /**
   * The entries of `kind` with the highest affinity at `now`, best first, at most `limit` of
   * them. Ties go by key, so the order is deterministic. Entries without a positive affinity are
   * left out.
   */
  top(
    kind: AffinityKind,
    { limit = 20, now = this.#now() }: { limit?: number; now?: number } = {},
  ): AffinityScore[] {
    const scored: AffinityScore[] = []
    for (const entry of this.#entries.values()) {
      if (entry.kind !== kind) continue
      const { score, skips } = affinityAt(entry, now, this.halfLifeMs)
      if (score > 0) scored.push({ entry, score, skips })
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.key < b.entry.key ? -1 : 1))
    return scored.slice(0, Math.max(0, Math.floor(limit)))
  }

  /** Every entry, or every entry of one kind, in no particular order. */
  entries(kind?: AffinityKind): AffinityEntry[] {
    const all = [...this.#entries.values()]
    return kind === undefined ? all : all.filter((entry) => entry.kind === kind)
  }
}
