/**
 * Home: the shelves built from the user's taste and the candidates collected for them
 * (ARCHITECTURE.md §13, "Home shelves").
 *
 * | Shelf | What it holds |
 * |---|---|
 * | Quick picks | What to play now: favourites and new songs, scored for affinity; nothing played in the last 12 hours |
 * | Daily Mix 1–6 | One per cluster of the user's top artists (artists the sources link): their favourite songs and new ones, about half each, changing once a day |
 * | Discover | Songs the user has never played, preferably by new artists, changing once a week |
 * | Because you listened to X | What the sources suggest for one recent play, new to the user |
 * | On repeat | The songs played most in the last 30 days |
 * | Rediscover | Songs the user loved (played three times or more, or liked) and hasn't played for 30 days |
 * | Spotify's sections | The personal home of a connected Spotify account, as Spotify gives it |
 *
 * Every list goes through the catalog mode, de-duplication against the listening history, MMR
 * diversity and a per-artist cap, and no track shows in two of the first five kinds of shelf
 * (mixes are lists of their own). The build is pure and deterministic: the same input gives the
 * same shelves. Randomness comes from the injected `random` (Quick picks) and from sources
 * seeded with the day or week (the mixes, Discover, Rediscover), so lists change between
 * periods, not between builds.
 *
 * @module
 */

import type { CatalogMode } from '../mode'
import type { Shelf, Track } from '../model'
import type { RandomSource } from '../queue/random'
import { DEFAULT_AFFINITY_WEIGHTS } from '../signals/affinity'
import { createPicker, diversify } from './diversify'
import { filterHistory } from './history'
import { seedArtistKey, seedKey, trackKeys } from './identity'
import { periodKey, seededRandomFor } from './period'
import {
  type CandidatePool,
  combineStrengths,
  compareKeys,
  fitsMode,
  type PooledSong,
  poolCandidates,
} from './pool'
import { byScore, SCORE_PRESETS, type ScoredSong, scoreSongs } from './score'
import { type PlannedSeed, planSeeds, seedWeight } from './seeds'
import { NO_STABLE_SHELVES, type StableEntry, type StableShelves } from './stable'
import { indexTaste, likedEnough, type TasteIndex, type TrackTaste } from './taste'
import type { RecCandidate, RecSeed, RecTrackCandidate, TasteProfile } from './types'

/** One track on a shelf. */
export interface HomeTrack {
  /** The track. */
  readonly track: Track
  /** Its score on that shelf. */
  readonly score: number
  /** Whether the user already knows it (played, liked or saved it). */
  readonly familiar: boolean
}

/** One Daily Mix: a cluster of the user's top artists, their favourite songs and new ones. */
export interface DailyMix {
  /** Stable within the day: `daily-mix-1` to `daily-mix-6`. */
  readonly id: string
  /** "Daily Mix 1". */
  readonly title: string
  /** The cluster's artists, the one it grew from first. */
  readonly artists: readonly string[]
  /** The mix. */
  readonly tracks: readonly HomeTrack[]
}

/** A shelf of tracks. */
interface TrackShelf<T extends string> {
  readonly type: T
  /** Stable, unique within the feed. */
  readonly id: string
  /** The plan's name for it. */
  readonly title: string
  /** The tracks, in order. */
  readonly items: readonly HomeTrack[]
}

/** One shelf of Home. */
export type HomeShelf =
  | TrackShelf<'quick-picks'>
  | {
      readonly type: 'daily-mixes'
      readonly id: string
      readonly title: string
      /** The mixes, Daily Mix 1 first. */
      readonly mixes: readonly DailyMix[]
    }
  | (TrackShelf<'discover'> & {
      /** The week it is for (`periodKey('week', …)`). */
      readonly period: string
    })
  | (TrackShelf<'because'> & {
      /** The play it grew from: its `name` is the X of "Because you listened to X". */
      readonly seed: RecSeed
    })
  | TrackShelf<'on-repeat'>
  | TrackShelf<'rediscover'>
  | {
      readonly type: 'source'
      readonly id: string
      readonly title: string
      readonly subtitle?: string
      /** The service whose section it is, e.g. `spotify`. */
      readonly source: string
      /** The section, with its tracks filtered to the catalog mode. */
      readonly shelf: Shelf
    }

/** The kinds of shelf. */
export type HomeShelfType = HomeShelf['type']

/** A shelf of a service's own home feed (stage 3.2's `SourceShelf`). */
export interface SourceShelfInput {
  /** The service, e.g. `spotify`. */
  readonly source: string
  /** The shelf. */
  readonly shelf: Shelf
}

/** What every list of tracks is tuned by. */
export interface ListOptions {
  /** Most tracks. */
  readonly limit: number
  /** Fewer tracks than this, and the shelf is left out. */
  readonly minItems: number
  /** Most tracks per artist. */
  readonly perArtistCap: number
  /** MMR's trade-off between relevance and variety (1 keeps the ranking). */
  readonly lambda: number
  /** Up to ± this much noise on every score, so lists change between periods. */
  readonly jitter: number
}

/** How Home is tuned. Every value has a default ({@link DEFAULT_HOME_OPTIONS}). */
export interface HomeOptions {
  readonly quickPicks: ListOptions & {
    /** Leave out songs played less than this long ago. */
    readonly recentMs: number
  }
  readonly because: ListOptions & {
    /** Most "Because you listened" shelves. */
    readonly shelves: number
  }
  readonly discover: ListOptions & {
    /** Discover is kept for the week only when it holds at least this many tracks. */
    readonly keepAtLeast: number
    /** Leave out songs by artists the user knows this well or better (0–1). */
    readonly maxArtistFamiliarity: number
  }
  readonly mixes: ListOptions & {
    /** Most mixes. */
    readonly count: number
    /** Most artists one mix grows from. */
    readonly artistsPerMix: number
    /** At most this share of a mix is songs the user knows. */
    readonly familiarShare: number
    /** Two artists join one mix when the sources link them at least this strongly (0–1). */
    readonly linkThreshold: number
    /** New songs played less than this long ago stay out. */
    readonly recentMs: number
  }
  readonly onRepeat: ListOptions & {
    /** Only songs played within this long. */
    readonly windowMs: number
    /** Only songs played at least this often. */
    readonly minPlays: number
  }
  readonly rediscover: ListOptions & {
    /** Only songs not played (or touched) for this long. */
    readonly afterMs: number
    /** Songs played at least this often, or liked. */
    readonly minPlays: number
  }
  /** Most sections from a service's own home. */
  readonly sourceShelves: number
}

/** Partial {@link HomeOptions}: give only what differs. */
export type HomeOptionsInput = {
  readonly [K in keyof HomeOptions]?: HomeOptions[K] extends number
    ? number
    : Partial<HomeOptions[K]>
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** How Home is tuned unless the input says otherwise. */
export const DEFAULT_HOME_OPTIONS: HomeOptions = Object.freeze({
  quickPicks: Object.freeze({
    limit: 20,
    minItems: 4,
    perArtistCap: 2,
    lambda: 0.75,
    jitter: 0.04,
    recentMs: 12 * HOUR_MS,
  }),
  because: Object.freeze({
    limit: 12,
    minItems: 4,
    perArtistCap: 2,
    lambda: 0.7,
    jitter: 0,
    shelves: 3,
  }),
  discover: Object.freeze({
    limit: 30,
    minItems: 6,
    perArtistCap: 2,
    lambda: 0.6,
    jitter: 0.06,
    keepAtLeast: 10,
    maxArtistFamiliarity: 0.8,
  }),
  mixes: Object.freeze({
    limit: 30,
    minItems: 10,
    perArtistCap: 5,
    lambda: 0.6,
    jitter: 0.05,
    count: 6,
    artistsPerMix: 4,
    familiarShare: 0.5,
    linkThreshold: 0.25,
    recentMs: 3 * DAY_MS,
  }),
  onRepeat: Object.freeze({
    limit: 15,
    minItems: 3,
    perArtistCap: 3,
    lambda: 0.9,
    jitter: 0,
    windowMs: 30 * DAY_MS,
    minPlays: 2,
  }),
  rediscover: Object.freeze({
    limit: 15,
    minItems: 3,
    perArtistCap: 2,
    lambda: 0.8,
    jitter: 0.05,
    afterMs: 30 * DAY_MS,
    minPlays: 3,
  }),
  sourceShelves: 6,
})

/** Everything a Home is built from. */
export interface HomeInput {
  /** The user's taste. An empty profile is the cold start. */
  readonly profile: TasteProfile
  /**
   * Every candidate collected for the seeds (stage 3.2's collector), plus the tracks of expanded
   * artists and found songs (see `planExpansions`).
   */
  readonly candidates?: readonly RecCandidate[]
  /** The seeds the candidates were collected for. Default: `planSeeds` of the profile. */
  readonly seeds?: readonly PlannedSeed[]
  /** Sections of the services' own home feeds (stage 3.2's `home()`). */
  readonly sourceShelves?: readonly SourceShelfInput[]
  /**
   * Whether the user's Spotify account is connected (stage 3.5), with Spotify switched on and
   * reachable: only then do Spotify's sections show.
   */
  readonly spotifyConnected?: boolean
  /** The catalog mode. */
  readonly mode: CatalogMode
  /** The time, as epoch milliseconds. */
  readonly now: number
  /** Local time's offset from UTC in minutes, for days and weeks. Default 0. */
  readonly utcOffsetMinutes?: number
  /** Noise for Quick picks. Default: a source seeded with the hour, so a rebuild changes nothing. */
  readonly random?: RandomSource
  /** The lists kept from earlier builds (see `stable.ts`). */
  readonly stable?: StableShelves
  /** Tuning. */
  readonly options?: HomeOptionsInput
}

/** A built Home. */
export interface HomeFeed {
  /** The shelves, in the order to show them. */
  readonly shelves: readonly HomeShelf[]
  /** Whether FXM knows too little about the user's taste: Home should ask (onboarding). */
  readonly coldStart: boolean
  /** The lists to keep for the next build: store them and pass them back as `stable`. */
  readonly stable: StableShelves
}

/** The options with the defaults filled in. */
export function resolveHomeOptions(input: HomeOptionsInput = {}): HomeOptions {
  const merged: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(DEFAULT_HOME_OPTIONS)) {
    const override = (input as Record<string, unknown>)[name]
    merged[name] =
      typeof value === 'object'
        ? { ...value, ...(typeof override === 'object' ? override : {}) }
        : typeof override === 'number'
          ? override
          : value
  }
  return merged as unknown as HomeOptions
}

/** What the user already knows, as candidates: their tracks, for the familiar half of lists. */
export function familiarCandidates(taste: TasteIndex, mode: CatalogMode): RecTrackCandidate[] {
  const candidates: RecTrackCandidate[] = []
  taste.tracks.forEach((known, rank) => {
    const track = known.track
    if (track === undefined || known.score <= 0 || !fitsMode(track, mode)) return
    candidates.push({
      type: 'track',
      source: 'library',
      part: 'library',
      seed: { type: 'artist', name: track.artists[0]?.name ?? '' },
      rank,
      score: 0,
      track,
    })
  })
  return candidates
}

/** A list that may be kept for its period: the shelf to show and the entry to keep. */
interface DiscoverResult {
  readonly shelf?: HomeShelf
  readonly keep?: StableEntry
}

const DISCOVER = 'Discover'

/** A builder's shared state. */
interface Build {
  readonly taste: TasteIndex
  readonly mode: CatalogMode
  readonly options: HomeOptions
  /** Pooled songs that have a track, by every key. */
  readonly songByKey: ReadonlyMap<string, PooledSong>
  /** Pooled songs that have a track, most similar first. */
  readonly songs: readonly PooledSong[]
  /** Keys of the songs placed on a shelf so far. */
  readonly placed: Set<string>
  readonly day: string
  readonly week: string
}

function toHomeTracks(build: Build, items: readonly { song: PooledSong; score: number }[]) {
  return items.map((item) => ({
    track: item.song.track as Track,
    score: item.score,
    familiar: build.taste.known(item.song.keys),
  }))
}

function place(build: Build, items: readonly { song: PooledSong }[]) {
  for (const item of items) for (const key of item.song.keys) build.placed.add(key)
}

/** Whether a song has evidence from the sources rather than only from the library. */
function suggested(song: PooledSong): boolean {
  return song.evidence.some((one) => one.strength > 0)
}

/** Whether the user mostly skips it: at least one whole skip, and twice as much as they listen. */
function disliked(taste: { readonly score: number; readonly skips: number } | undefined): boolean {
  return taste !== undefined && taste.skips >= 1 && taste.skips > 2 * Math.max(0, taste.score)
}

/**
 * The scored songs a list of recommendations may hold: a positive score, and neither the track
 * nor its main artist one the user mostly skips.
 */
function welcome<T extends { readonly song: PooledSong; readonly score: number }>(
  build: Build,
  items: readonly T[],
): T[] {
  return items.filter(
    ({ song, score }) =>
      score > 0 &&
      !disliked(build.taste.track(song.keys)) &&
      !disliked(build.taste.artist(song.artistKeys[0])),
  )
}

/** The pooled song of a profile track, if it has one. */
function songOfTaste(build: Build, known: TrackTaste): PooledSong | undefined {
  for (const key of known.keys) {
    const song = build.songByKey.get(key)
    if (song !== undefined) return song
  }
  return undefined
}

/** Discover as kept for this week, if it is: its songs are placed first. */
function keptDiscover(build: Build, kept: StableEntry | undefined): DiscoverResult | undefined {
  if (kept?.kind !== 'discover' || kept.period !== build.week || kept.mode !== build.mode) {
    return undefined
  }
  const options = build.options.discover
  const items = kept.items.filter((item) => fitsMode(item.track, build.mode))
  for (const item of items) for (const key of trackKeys(item.track)) build.placed.add(key)
  return {
    keep: kept,
    ...(items.length >= options.minItems
      ? { shelf: { type: 'discover', id: 'discover', title: DISCOVER, items, period: build.week } }
      : {}),
  }
}

/** A Discover built now: kept for the week when it holds enough songs to last it. */
function newDiscover(build: Build, shelf: HomeShelf | undefined): DiscoverResult {
  if (shelf?.type !== 'discover') return {}
  if (shelf.items.length < build.options.discover.keepAtLeast) return { shelf }
  return {
    shelf,
    keep: { kind: 'discover', mode: build.mode, period: build.week, items: shelf.items },
  }
}

function onRepeatShelf(build: Build): HomeShelf | undefined {
  const options = build.options.onRepeat
  const since = build.taste.now - options.windowMs
  const ranked: Array<{ song: PooledSong; score: number }> = []
  for (const known of build.taste.tracks) {
    const lastPlayedAt = known.entry.lastPlayedAt
    if (
      known.track === undefined ||
      !likedEnough(known) ||
      known.entry.plays < options.minPlays ||
      lastPlayedAt === undefined ||
      lastPlayedAt < since
    ) {
      continue
    }
    const song = songOfTaste(build, known)
    if (song !== undefined) ranked.push({ song, score: known.norm - 0.5 * known.skipShare })
  }
  const picked = diversify(
    filterHistory(ranked.sort(byScore), build.taste, { exclude: build.placed }),
    options,
  )
  if (picked.length < options.minItems) return undefined
  place(build, picked)
  return {
    type: 'on-repeat',
    id: 'on-repeat',
    title: 'On repeat',
    items: toHomeTracks(build, picked),
  }
}

function rediscoverShelf(build: Build): HomeShelf | undefined {
  const options = build.options.rediscover
  const before = build.taste.now - options.afterMs
  const random = seededRandomFor('rediscover', build.day, build.mode)
  const candidates = build.taste.tracks
    .filter((known) => {
      const { entry } = known
      const lastTouched = Math.max(entry.lastPlayedAt ?? 0, entry.at)
      return (
        known.track !== undefined &&
        entry.skips < entry.score &&
        lastTouched < before &&
        (entry.plays >= options.minPlays || entry.score >= DEFAULT_AFFINITY_WEIGHTS.like)
      )
    })
    .sort((a, b) => compareKeys(a.entry.key, b.entry.key))
  const ranked: Array<{ song: PooledSong; score: number }> = []
  for (const known of candidates) {
    const noise = (random() - 0.5) * 2 * options.jitter
    const song = songOfTaste(build, known)
    if (song === undefined) continue
    const { entry } = known
    const score = Math.log1p(Math.max(0, entry.score)) + 0.1 * Math.log1p(entry.plays) + noise
    ranked.push({ song, score })
  }
  const picked = diversify(
    filterHistory(ranked.sort(byScore), build.taste, { exclude: build.placed }),
    options,
  )
  if (picked.length < options.minItems) return undefined
  place(build, picked)
  return {
    type: 'rediscover',
    id: 'rediscover',
    title: 'Rediscover',
    items: toHomeTracks(build, picked),
  }
}

/** A list that competes with the others for the pool's songs (see {@link draft}). */
interface DraftList {
  /** Its candidates, ranked and filtered. */
  readonly items: readonly ScoredSong[]
  /** Its limit, minimum, cap and MMR trade-off. */
  readonly options: ListOptions
  /** The shelf it makes of what it picked. */
  readonly shelf: (picked: readonly ScoredSong[]) => HomeShelf
}

/** A list's picks after a {@link draft}. */
interface Drafted {
  readonly list: DraftList
  readonly picked: readonly ScoredSong[]
}

/**
 * Lets lists take turns picking their next song (by MMR within each list) until every list is
 * full or out of songs, so that in a small pool each list gets a share rather than the first
 * taking everything. No song goes to two lists. A list left below its minimum is dropped and the
 * draft runs again without it, so its songs go to the others. Places the picks, and returns
 * them for the lists that were kept, in the order of `lists`.
 */
function draft(build: Build, lists: readonly DraftList[]): Drafted[] {
  let active = [...lists]
  for (;;) {
    const placed = new Set(build.placed)
    const blocked = (song: PooledSong) => song.keys.some((key) => placed.has(key))
    const runs = active.map((list) => ({ list, picker: createPicker(list.items, list.options) }))
    let progress = true
    while (progress) {
      progress = false
      for (const { picker } of runs) {
        const item = picker.next(blocked)
        if (item === undefined) continue
        for (const key of item.song.keys) placed.add(key)
        progress = true
      }
    }
    const short = runs.filter(({ list, picker }) => picker.picked.length < list.options.minItems)
    if (short.length === 0) {
      for (const key of placed) build.placed.add(key)
      return runs.map(({ list, picker }) => ({ list, picked: picker.picked }))
    }
    active = active.filter((list) => !short.some((run) => run.list === list))
  }
}

/** Quick picks: what to play now, favourites and new songs; nothing just played. */
function quickPicksList(build: Build, random: RandomSource): DraftList {
  const options = build.options.quickPicks
  const scored = scoreSongs(build.songs, build.taste, {
    weights: SCORE_PRESETS.quickPicks,
    jitter: options.jitter,
    random,
  })
  return {
    items: filterHistory(welcome(build, scored), build.taste, { playedWithinMs: options.recentMs }),
    options,
    shelf: (picked) => ({
      type: 'quick-picks',
      id: 'quick-picks',
      title: 'Quick picks',
      items: toHomeTracks(build, picked),
    }),
  }
}

/** Because you listened to X: what the sources suggest for each seed, new to the user. */
function becauseLists(build: Build, seeds: readonly PlannedSeed[]): DraftList[] {
  const options = build.options.because
  return seeds
    .filter((seed) => seed.purposes.includes('because') && seed.ref.name.trim() !== '')
    .slice(0, options.shelves)
    .map((seed) => {
      const fromSeed = (song: PooledSong) =>
        combineStrengths(
          song.evidence.filter((one) => one.seedKey === seed.key).map((one) => one.strength),
        )
      const scored = scoreSongs(
        build.songs.filter((song) => fromSeed(song) > 0),
        build.taste,
        { weights: SCORE_PRESETS.because, similarity: fromSeed },
      )
      return {
        items: filterHistory(welcome(build, scored), build.taste, { unheard: true }),
        options,
        shelf: (picked) => ({
          type: 'because',
          id: `because:${seed.key}`,
          title: `Because you listened to ${seed.ref.name.trim()}`,
          seed: seed.ref,
          items: toHomeTracks(build, picked),
        }),
      }
    })
}

/** Discover: songs the user never played, by artists they hardly know. */
function discoverList(build: Build): DraftList {
  const options = build.options.discover
  const scored = scoreSongs(build.songs.filter(suggested), build.taste, {
    weights: SCORE_PRESETS.discover,
    jitter: options.jitter,
    random: seededRandomFor('discover', build.week, build.mode),
  })
  return {
    items: welcome(build, filterHistory(scored, build.taste, { unheard: true })).filter(
      ({ song }) =>
        (build.taste.artist(song.artistKeys[0])?.familiarity ?? 0) < options.maxArtistFamiliarity,
    ),
    options,
    shelf: (picked) => ({
      type: 'discover',
      id: 'discover',
      title: DISCOVER,
      items: toHomeTracks(build, picked),
      period: build.week,
    }),
  }
}

/** Links between artists: how strongly the sources tie each pair, from 0 to 1, both ways. */
function artistLinks(build: Build, pool: CandidatePool): (a: string, b: string) => number {
  const links = new Map<string, number[]>()
  const add = (a: string | undefined, b: string | undefined, strength: number) => {
    if (a === undefined || b === undefined || a === b || !(strength > 0)) return
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`
    const list = links.get(pair)
    if (list === undefined) links.set(pair, [strength])
    else list.push(strength)
  }
  for (const song of pool.songs) {
    for (const evidence of song.evidence) {
      add(seedArtistKey(evidence.seed), song.artistKeys[0], evidence.strength)
    }
  }
  for (const artist of pool.artists) {
    for (const evidence of artist.evidence) {
      add(seedArtistKey(evidence.seed), artist.key, evidence.strength)
    }
  }
  for (const known of build.taste.tracks) {
    const song = songOfTaste(build, known)
    const [main, ...featured] = song?.artistKeys ?? []
    for (const other of featured) add(main, other, 0.5)
  }
  const combined = new Map<string, number>()
  for (const [pair, strengths] of links) combined.set(pair, combineStrengths(strengths))
  return (a, b) => combined.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0
}

/**
 * The songs of a mix in order: the favourites spread evenly through the new songs, a favourite
 * first, each list in its own order.
 */
function spread<T>(familiar: readonly T[], fresh: readonly T[]): T[] {
  const total = familiar.length + fresh.length
  const slots = new Set(familiar.map((_, index) => Math.floor((index * total) / familiar.length)))
  const merged: T[] = []
  let i = 0
  let j = 0
  for (let slot = 0; slot < total; slot++) {
    if ((slots.has(slot) && i < familiar.length) || j >= fresh.length)
      merged.push(familiar[i++] as T)
    else merged.push(fresh[j++] as T)
  }
  return merged
}

function mixesShelf(
  build: Build,
  pool: CandidatePool,
  kept: StableEntry | undefined,
): { shelf?: HomeShelf; keep?: StableEntry } {
  const options = build.options.mixes
  const title = 'Daily Mixes'
  if (kept?.kind === 'mixes' && kept.period === build.day && kept.mode === build.mode) {
    const mixes = kept.mixes
      .map((mix) => ({
        ...mix,
        tracks: mix.tracks.filter((item) => fitsMode(item.track, build.mode)),
      }))
      .filter((mix) => mix.tracks.length > 0)
    return {
      keep: kept,
      ...(mixes.length > 0
        ? { shelf: { type: 'daily-mixes', id: 'daily-mixes', title, mixes } }
        : {}),
    }
  }
  const link = artistLinks(build, pool)
  const top = build.taste.artists
    .filter(likedEnough)
    .slice(0, options.count * options.artistsPerMix)
  const assigned = new Set<string>()
  const clusters: Array<typeof top> = []
  for (const anchor of top) {
    if (clusters.length >= options.count) break
    if (assigned.has(anchor.key)) continue
    assigned.add(anchor.key)
    const cluster = [anchor]
    const neighbours = top
      .filter(
        (other) => !assigned.has(other.key) && link(anchor.key, other.key) >= options.linkThreshold,
      )
      .sort(
        (a, b) =>
          link(anchor.key, b.key) - link(anchor.key, a.key) ||
          b.score - a.score ||
          compareKeys(a.key, b.key),
      )
      .slice(0, Math.max(0, options.artistsPerMix - 1))
    for (const other of neighbours) {
      assigned.add(other.key)
      cluster.push(other)
    }
    clusters.push(cluster)
  }

  const mixes: DailyMix[] = []
  clusters.forEach((cluster, index) => {
    const artists = new Set(cluster.map((artist) => artist.key))
    const random = seededRandomFor('mix', build.day, build.mode, String(index))
    const familiar: PooledSong[] = []
    const fresh: PooledSong[] = []
    for (const song of build.songs) {
      const main = song.artistKeys[0]
      const known = build.taste.known(song.keys)
      const byArtist = main !== undefined && artists.has(main)
      if (known) {
        const taste = build.taste.track(song.keys)
        if (byArtist && taste !== undefined && likedEnough(taste)) {
          familiar.push(song)
        }
        continue
      }
      const fromArtist = song.evidence.some(
        (evidence) => evidence.strength > 0 && artists.has(seedArtistKey(evidence.seed) ?? ''),
      )
      if (byArtist || fromArtist) fresh.push(song)
    }
    const score = (songs: readonly PooledSong[]) =>
      scoreSongs(songs, build.taste, {
        weights: SCORE_PRESETS.mix,
        jitter: options.jitter,
        random,
      })
    const familiarCount = Math.round(options.limit * options.familiarShare)
    const pickedFamiliar = diversify(welcome(build, score(familiar)), {
      ...options,
      limit: familiarCount,
    })
    const pickedFresh = diversify(
      filterHistory(welcome(build, score(fresh)), build.taste, {
        playedWithinMs: options.recentMs,
      }),
      { ...options, limit: options.limit - pickedFamiliar.length, after: pickedFamiliar },
    )
    const tracks = toHomeTracks(build, spread(pickedFamiliar, pickedFresh))
    if (tracks.length < options.minItems) return
    const number = mixes.length + 1
    mixes.push({
      id: `daily-mix-${number}`,
      title: `Daily Mix ${number}`,
      artists: cluster.map((artist) => artist.label),
      tracks,
    })
  })
  if (mixes.length === 0) return {}
  const shelf: HomeShelf = { type: 'daily-mixes', id: 'daily-mixes', title, mixes }
  return { shelf, keep: { kind: 'mixes', mode: build.mode, period: build.day, mixes } }
}

function sourceShelves(input: HomeInput, options: HomeOptions): HomeShelf[] {
  if (input.spotifyConnected !== true) return []
  const shelves: HomeShelf[] = []
  const ids = new Set<string>()
  for (const { source, shelf } of input.sourceShelves ?? []) {
    if (shelves.length >= options.sourceShelves) break
    if (source !== 'spotify' || typeof shelf?.id !== 'string' || !Array.isArray(shelf.items)) {
      continue
    }
    const id = `${source}:${shelf.id}`
    if (ids.has(id)) continue
    const items = shelf.items.filter(
      (item) => item?.type !== 'track' || fitsMode(item.track, input.mode),
    )
    if (items.length === 0) continue
    ids.add(id)
    shelves.push({
      type: 'source',
      id,
      title: shelf.title,
      ...(shelf.subtitle === undefined ? {} : { subtitle: shelf.subtitle }),
      source,
      shelf: { ...shelf, items },
    })
  }
  return shelves
}

/**
 * Builds Home (see the module documentation). Shelves that would hold too few tracks are left
 * out; with a cold start and no candidates, Home may have none, and `coldStart` says to ask the
 * user what they like.
 */
export function buildHome(input: HomeInput): HomeFeed {
  const options = resolveHomeOptions(input.options)
  const { mode, now } = input
  const offset = input.utcOffsetMinutes ?? 0
  const taste = indexTaste(input.profile, now)
  const seeds = input.seeds ?? planSeeds(taste, { mode })
  const plannedWeights = new Map(seeds.map((seed) => [seed.key, seed.weight]))
  const pool = poolCandidates([...(input.candidates ?? []), ...familiarCandidates(taste, mode)], {
    mode,
    seedWeight: (seed) => plannedWeights.get(seedKey(seed) ?? '') ?? seedWeight(taste, seed),
  })
  const songs = pool.songs.filter((song) => song.track !== undefined)
  const songByKey = new Map<string, PooledSong>()
  for (const song of songs)
    for (const key of song.keys) if (!songByKey.has(key)) songByKey.set(key, song)
  const day = periodKey('day', now, offset)
  const week = periodKey('week', now, offset)
  const build: Build = { taste, mode, options, songByKey, songs, placed: new Set(), day, week }

  const stable = input.stable ?? NO_STABLE_SHELVES
  const keptOf = (kind: StableEntry['kind']) =>
    stable.entries.find((entry) => entry.kind === kind && entry.mode === mode)
  const random =
    input.random ?? seededRandomFor('quick-picks', day, String(Math.floor(now / HOUR_MS)))

  // What is fixed comes first (a Discover kept for the week, the user's own tracks); then the
  // lists of recommendations draft the pool's songs between them.
  const kept = keptDiscover(build, keptOf('discover'))
  const onRepeat = onRepeatShelf(build)
  const rediscover = rediscoverShelf(build)
  const quickPicksDraft = quickPicksList(build, random)
  const becauseDrafts = becauseLists(build, seeds)
  const discoverDraft = kept === undefined ? discoverList(build) : undefined
  const drafted = draft(build, [
    quickPicksDraft,
    ...becauseDrafts,
    ...(discoverDraft === undefined ? [] : [discoverDraft]),
  ])
  const shelfOf = (list: DraftList | undefined) => {
    const run = drafted.find((one) => one.list === list)
    return run === undefined ? undefined : run.list.shelf(run.picked)
  }
  const quickPicks = shelfOf(quickPicksDraft)
  const because = becauseDrafts.map(shelfOf).filter((shelf) => shelf !== undefined)
  const discover = kept ?? newDiscover(build, shelfOf(discoverDraft))
  const mixes = mixesShelf(build, pool, keptOf('mixes'))

  const shelves = [
    quickPicks,
    mixes.shelf,
    discover.shelf,
    ...because,
    onRepeat,
    rediscover,
    ...sourceShelves(input, options),
  ].filter((shelf): shelf is HomeShelf => shelf !== undefined)

  // Keep this build's lists, and those of the other mode while their period lasts.
  const current = (entry: StableEntry) => entry.period === (entry.kind === 'discover' ? week : day)
  const entries: StableEntry[] = [
    ...[discover.keep, mixes.keep].filter((entry): entry is StableEntry => entry !== undefined),
    ...stable.entries.filter((entry) => entry.mode !== mode && current(entry)),
  ]
  return { shelves, coldStart: taste.coldStart, stable: { entries } }
}
