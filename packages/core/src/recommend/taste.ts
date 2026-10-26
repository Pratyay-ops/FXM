/**
 * The user's taste, indexed for the engine at one moment: every track's, artist's and tag's
 * affinity decayed to `now` and normalized to 0–1, what the user played and when, and whether
 * FXM knows too little to recommend anything yet (the cold start).
 *
 * Affinities are normalized on a log scale against the strongest of their kind,
 * `log(1 + a) / log(1 + max)`, so a favourite artist is 1 and one played a third as much still
 * counts for well over a third: listening more says less and less about how much more someone
 * likes an artist.
 *
 * @module
 */

import { type EntityId, entityKey, isEntityId } from '../ids'
import type { Track } from '../model'
import {
  AFFINITY_HALF_LIFE_MS,
  type AffinityEntry,
  affinityAt,
  DEFAULT_AFFINITY_WEIGHTS,
} from '../signals/affinity'
import { tagAffinityKey } from '../signals/keys'
import { artistKeyOf, trackKeys } from './identity'
import type { RecentPlay, TastePicks, TasteProfile } from './types'

/**
 * Fewer artists with an affinity than this is a cold start: Home asks for a few artists and
 * genres before it recommends anything.
 */
export const MIN_TASTE_ARTISTS = 3

/** How much an onboarding pick counts: as much as a like. */
export const PICK_WEIGHT = DEFAULT_AFFINITY_WEIGHTS.like

/** Below this affinity, a track or an artist says too little to build on: half a play. */
export const MIN_LIKED_SCORE = 0.5

/**
 * Whether the user likes a track or an artist enough to build recommendations on: an affinity
 * of at least {@link MIN_LIKED_SCORE}, and more listening than skipping.
 */
export function likedEnough(taste: { readonly score: number; readonly skips: number }): boolean {
  return taste.score >= MIN_LIKED_SCORE && taste.skips < taste.score
}

/** Plays of an artist after which the user counts as knowing them well. */
const FAMILIAR_PLAYS = 5

/** The affinity of one track at the index's time. */
export interface TrackTaste {
  /** The stored entry. */
  readonly entry: AffinityEntry
  /** The track's metadata, when the profile has it. */
  readonly track?: Track
  /** Every key the track is known by (see `trackKeys`). */
  readonly keys: readonly string[]
  /** Its affinity now. */
  readonly score: number
  /** Its skips now. */
  readonly skips: number
  /** Its affinity now, from 0 to 1 against the strongest track's. */
  readonly norm: number
  /** How much of what the user did with it was skipping: `skips / (skips + score + 1)`. */
  readonly skipShare: number
}

/** The affinity of one artist at the index's time. */
export interface ArtistTaste {
  /** The artist's key (see `artistKeyOf`). */
  readonly key: string
  /** The name as last spelled. */
  readonly label: string
  /** The artist's IDs in the sources it came with. */
  readonly ids: readonly EntityId[]
  /** Its affinity now. */
  readonly score: number
  /** Its skips now. */
  readonly skips: number
  /** Plays of its tracks, all time. */
  readonly plays: number
  /** Its affinity now, from 0 to 1 against the strongest artist's. */
  readonly norm: number
  /** How much of what the user did with it was skipping. */
  readonly skipShare: number
  /** Whether the user picked the artist in the onboarding. */
  readonly picked: boolean
  /**
   * How well the user knows the artist, from 0 (never played) to 1 (played often, or picked:
   * the user named them, so they are nobody new).
   */
  readonly familiarity: number
}

/** The taste of one user at one moment, indexed for the engine. */
export interface TasteIndex {
  /** The moment, as epoch milliseconds. */
  readonly now: number
  /** Whether FXM knows too little: fewer than {@link MIN_TASTE_ARTISTS} artists with an affinity. */
  readonly coldStart: boolean
  /** Every profile track, strongest first (ties by key). */
  readonly tracks: readonly TrackTaste[]
  /** Every artist with an affinity, strongest first (ties by key). */
  readonly artists: readonly ArtistTaste[]
  /** The recent plays, most recent first. */
  readonly recent: readonly RecentPlay[]
  /** The strongest track entry known by any of `keys`. */
  track(keys: readonly string[]): TrackTaste | undefined
  /** One artist's affinity, by key. */
  artist(key: string | undefined): ArtistTaste | undefined
  /** One tag's affinity now, from 0 to 1; 0 when there is none. */
  tag(key: string): number
  /** Whether the user knows the track: played, liked or saved it. */
  known(keys: readonly string[]): boolean
  /** When the track last started playing, as far as the profile knows. */
  lastPlayedAt(keys: readonly string[]): number | undefined
  /** How many plays ago the track last played: 0 for the latest play. */
  playsAgo(keys: readonly string[]): number | undefined
}

/** Options for {@link indexTaste}. */
export interface TasteOptions {
  /** The affinity's half-life. Default: stage 3.1's 14 days. */
  readonly halfLifeMs?: number
}

/** `log(1 + value) / log(1 + max)`, 0 for anything not positive. */
function normalize(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.min(1, Math.log1p(value) / Math.log1p(max))
}

function skipShareOf(score: number, skips: number): number {
  return skips > 0 ? skips / (skips + Math.max(0, score) + 1) : 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isEntry(value: unknown, kind: AffinityEntry['kind']): value is AffinityEntry {
  const entry = value as AffinityEntry | undefined
  return (
    typeof entry === 'object' &&
    entry !== null &&
    entry.kind === kind &&
    typeof entry.key === 'string' &&
    isTime(entry.at) &&
    Number.isFinite(entry.score) &&
    Number.isFinite(entry.skips)
  )
}

/**
 * What onboarding picks contribute: an artist entry for each picked artist and a tag entry for
 * each genre, each worth {@link PICK_WEIGHT} at the time of the picks. Placeholders and empty
 * names count for nothing.
 */
export function pickContributions(picks: TastePicks | undefined): AffinityEntry[] {
  if (picks === undefined || !isTime(picks.at)) return []
  const entries: AffinityEntry[] = []
  const seen = new Set<string>()
  for (const artist of Array.isArray(picks.artists) ? picks.artists : []) {
    const key = artistKeyOf(artist?.name)
    if (key === undefined || seen.has(`artist|${key}`)) continue
    seen.add(`artist|${key}`)
    entries.push({
      kind: 'artist',
      key,
      label: artist.name.trim(),
      ids: isEntityId(artist.id, 'artist') ? [artist.id] : [],
      at: picks.at,
      score: PICK_WEIGHT,
      skips: 0,
      plays: 0,
    })
  }
  for (const genre of Array.isArray(picks.genres) ? picks.genres : []) {
    const key = typeof genre === 'string' ? tagAffinityKey(genre) : undefined
    if (key === undefined || seen.has(`tag|${key}`)) continue
    seen.add(`tag|${key}`)
    entries.push({
      kind: 'tag',
      key,
      label: genre.trim(),
      ids: [],
      at: picks.at,
      score: PICK_WEIGHT,
      skips: 0,
      plays: 0,
    })
  }
  return entries
}

/** Mutable totals of one artist while indexing. */
interface ArtistTotals {
  key: string
  label: string
  labelAt: number
  ids: EntityId[]
  score: number
  skips: number
  plays: number
  picked: boolean
}

/**
 * Indexes a taste profile at `now`. Malformed entries and plays are left out, so data read back
 * from storage can't break the engine. Artists are keyed by `artistKeyOf` their name, so entries
 * a channel suffix kept apart count as one artist.
 */
export function indexTaste(
  profile: TasteProfile,
  now: number,
  options: TasteOptions = {},
): TasteIndex {
  const halfLifeMs = options.halfLifeMs ?? AFFINITY_HALF_LIFE_MS

  // Artists: the entries plus the onboarding picks, merged by key.
  const picks = pickContributions(profile.picks)
  const artistTotals = new Map<string, ArtistTotals>()
  const artistEntries = [
    ...(profile.artists ?? []).map((entry) => ({ entry, picked: false })),
    ...picks.filter((entry) => entry.kind === 'artist').map((entry) => ({ entry, picked: true })),
  ]
  for (const { entry, picked } of artistEntries) {
    if (!isEntry(entry, 'artist')) continue
    const key = artistKeyOf(entry.label) ?? entry.key
    const { score, skips } = affinityAt(entry, now, halfLifeMs)
    const totals = artistTotals.get(key) ?? {
      key,
      label: entry.label,
      labelAt: -1,
      ids: [],
      score: 0,
      skips: 0,
      plays: 0,
      picked: false,
    }
    totals.score += score
    totals.skips += skips
    totals.plays += Number.isFinite(entry.plays) ? Math.max(0, entry.plays) : 0
    totals.picked ||= picked
    if (entry.at > totals.labelAt && typeof entry.label === 'string' && entry.label !== '') {
      totals.label = entry.label
      totals.labelAt = entry.at
    }
    for (const id of Array.isArray(entry.ids) ? entry.ids : []) {
      if (isEntityId(id, 'artist') && !totals.ids.includes(id)) totals.ids.push(id)
    }
    artistTotals.set(key, totals)
  }
  const maxArtist = Math.max(0, ...[...artistTotals.values()].map((totals) => totals.score))
  const artists: ArtistTaste[] = [...artistTotals.values()]
    .map((totals) => ({
      key: totals.key,
      label: totals.label,
      ids: totals.ids,
      score: totals.score,
      skips: Math.max(0, totals.skips),
      plays: totals.plays,
      norm: normalize(totals.score, maxArtist),
      skipShare: skipShareOf(totals.score, totals.skips),
      picked: totals.picked,
      familiarity: totals.picked
        ? 1
        : Math.min(1, totals.plays / FAMILIAR_PLAYS + (totals.score > 0 ? 0.2 : 0)),
    }))
    .filter((artist) => artist.score > 0 || artist.skips > 0 || artist.plays > 0)
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const artistByKey = new Map(artists.map((artist) => [artist.key, artist]))

  // Tags.
  const tagScores = new Map<string, number>()
  const tagEntries = [...(profile.tags ?? []), ...picks.filter((entry) => entry.kind === 'tag')]
  for (const entry of tagEntries) {
    if (!isEntry(entry, 'tag')) continue
    const key = tagAffinityKey(entry.label) ?? entry.key
    tagScores.set(key, (tagScores.get(key) ?? 0) + affinityAt(entry, now, halfLifeMs).score)
  }
  const maxTag = Math.max(0, ...tagScores.values())

  // Tracks.
  const raw: Array<Omit<TrackTaste, 'norm'>> = []
  for (const profileTrack of profile.tracks ?? []) {
    const entry = profileTrack?.entry
    if (!isEntry(entry, 'track')) continue
    const track = profileTrack.track
    const keys = track !== undefined ? trackKeys(track) : []
    if (!keys.includes(entry.key)) keys.unshift(entry.key)
    const { score, skips } = affinityAt(entry, now, halfLifeMs)
    raw.push({
      entry,
      ...(track === undefined || !isEntityId(track.id, 'track') ? {} : { track }),
      keys,
      score,
      skips,
      skipShare: skipShareOf(score, skips),
    })
  }
  const maxTrack = Math.max(0, ...raw.map((track) => track.score))
  const tracks: TrackTaste[] = raw
    .map((track) => ({ ...track, norm: normalize(track.score, maxTrack) }))
    .sort(
      (a, b) =>
        b.score - a.score || (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0),
    )
  const trackByKey = new Map<string, TrackTaste>()
  for (const track of tracks) {
    for (const key of track.keys) if (!trackByKey.has(key)) trackByKey.set(key, track)
  }

  // Plays: the profile's last plays and the recent history, newest first.
  const recent = (profile.recent ?? [])
    .filter((play) => isEntityId(play?.trackId, 'track') && isTime(play.playedAt))
    .slice()
    .sort((a, b) => b.playedAt - a.playedAt)
  const lastPlayed = new Map<string, number>()
  const playsAgo = new Map<string, number>()
  const known = new Set<string>()
  recent.forEach((play, index) => {
    const keys = play.track !== undefined ? trackKeys(play.track) : []
    const key = entityKey(play.trackId)
    if (!keys.includes(key)) keys.unshift(key)
    for (const one of keys) {
      known.add(one)
      if (!playsAgo.has(one)) playsAgo.set(one, index)
      lastPlayed.set(one, Math.max(lastPlayed.get(one) ?? -Infinity, play.playedAt))
    }
  })
  for (const track of tracks) {
    const at = track.entry.lastPlayedAt
    const knows = track.entry.plays > 0 || track.score > 0 || isTime(at)
    for (const key of track.keys) {
      if (knows) known.add(key)
      if (isTime(at)) lastPlayed.set(key, Math.max(lastPlayed.get(key) ?? -Infinity, at))
    }
  }

  const strongest = (keys: readonly string[]): TrackTaste | undefined => {
    let best: TrackTaste | undefined
    for (const key of keys) {
      const found = trackByKey.get(key)
      if (found !== undefined && (best === undefined || found.score > best.score)) best = found
    }
    return best
  }

  return {
    now,
    coldStart: artists.filter((artist) => artist.score > 0).length < MIN_TASTE_ARTISTS,
    tracks,
    artists,
    recent,
    track: strongest,
    artist: (key) => (key === undefined ? undefined : artistByKey.get(key)),
    tag: (key) => normalize(tagScores.get(key) ?? 0, maxTag),
    known: (keys) => keys.some((key) => known.has(key)),
    lastPlayedAt(keys) {
      let last: number | undefined
      for (const key of keys) {
        const at = lastPlayed.get(key)
        if (at !== undefined && (last === undefined || at > last)) last = at
      }
      return last
    },
    playsAgo(keys) {
      let least: number | undefined
      for (const key of keys) {
        const ago = playsAgo.get(key)
        if (ago !== undefined && (least === undefined || ago < least)) least = ago
      }
      return least
    },
  }
}
