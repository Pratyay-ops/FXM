/**
 * Candidate pooling: every listing of one song, from every source and seed, becomes one
 * {@link PooledSong}, and every listing of one artist one {@link PooledArtist}. A pooled
 * candidate keeps each listing as {@link Evidence}, and its similarity to what the user likes
 * combines them, so songs that several sources agree on rank higher.
 *
 * Two listings are one song when they share a key: a track's `entityKey` or the song identity
 * (main artist and title proper, see `songIdentity`). The track shown for a song is the listing
 * that plays most directly: a local file, then YouTube Music, the free sources, plain YouTube
 * and Spotify, whose tracks still need matching to audio.
 *
 * @module
 */

import { type CatalogMode, isPlayable, modePolicy } from '../mode'
import type { Track } from '../model'
import { tagAffinityKey } from '../signals/keys'
import {
  artistKeyOf,
  artistKeysOf,
  seedKey,
  seedSongKeys,
  songIdentity,
  trackKeys,
} from './identity'
import type { RecArtist, RecCandidate, RecSeed } from './types'

/** One listing of a pooled candidate: who suggested it, for what, and how strongly. */
export interface Evidence {
  /** The service, e.g. `ytm`. */
  readonly source: string
  /** The call, e.g. `radio`. */
  readonly part: string
  /** What it was suggested for. */
  readonly seed: RecSeed
  /** The seed's key (`seedKey`), or `''` for a seed without one. */
  readonly seedKey: string
  /** Its position in the service's list. */
  readonly rank: number
  /** The service's own score, from 0 to 1. */
  readonly score: number
  /**
   * What the listing contributes to the candidate's similarity, from 0 to 1: the score weighed
   * by the source, the part and the seed (see {@link PoolOptions}).
   */
  readonly strength: number
}

/** One song after pooling: every listing of it merged. */
export interface PooledSong {
  /** Its main key: the shown track's `entityKey`, else its song identity. */
  readonly key: string
  /** Every key a listing of it is known by. */
  readonly keys: readonly string[]
  /**
   * The track to show and play. Absent when every listing is a song search, which a search
   * must turn into a track first (see `planExpansions`).
   */
  readonly track?: Track
  /** The title. */
  readonly title: string
  /** The artists' names, main artist first. */
  readonly artists: readonly string[]
  /** The artists' keys (`artistKeyOf`), main artist first. */
  readonly artistKeys: readonly string[]
  /** The tags of every listing, as `tagAffinityKey`s, at most 10. */
  readonly tags: readonly string[]
  /** Its length in milliseconds, when known. */
  readonly durationMs?: number
  /** A YouTube video a song search linked, when there is no track. */
  readonly youtubeId?: string
  /** The highest popularity (0–100) any listing gave. */
  readonly popularity?: number
  /** Every listing, strongest first. */
  readonly evidence: readonly Evidence[]
  /**
   * How strongly the sources suggest it, from 0 to 1: the evidence combined like independent
   * votes, `1 − Π(1 − strength)`, so agreement between sources and seeds adds up without ever
   * passing 1.
   */
  readonly similarity: number
}

/** One artist after pooling: every listing of it merged. */
export interface PooledArtist {
  /** Its key (`artistKeyOf`). */
  readonly key: string
  /** The listing to use: one with an ID and photos when there is one. */
  readonly artist: RecArtist
  /** Every listing, strongest first. */
  readonly evidence: readonly Evidence[]
  /** How strongly the sources suggest it, from 0 to 1, combined like a song's. */
  readonly similarity: number
}

/** Everything pooled from one set of candidates. */
export interface CandidatePool {
  /** The songs, most similar first (ties by key). */
  readonly songs: readonly PooledSong[]
  /** The artists, most similar first (ties by key). */
  readonly artists: readonly PooledArtist[]
}

/** How much the listings of each source and part count, from 0 to 1. */
export interface EvidenceWeights {
  /** By service. A service that is not listed counts {@link EvidenceWeights.otherSource}. */
  readonly sources: Readonly<Record<string, number>>
  /** By call. A call that is not listed counts {@link EvidenceWeights.otherPart}. */
  readonly parts: Readonly<Record<string, number>>
  /** Any other service. */
  readonly otherSource: number
  /** Any other call. */
  readonly otherPart: number
}

/**
 * How much listings count by default. Radio from YouTube Music and Spotify is the strongest
 * evidence; Last.fm and ListenBrainz come from fewer listeners; similar artists say less about
 * one song than a radio does. The `library` source (what the user already knows) adds no
 * similarity: its tracks rank by their affinity instead.
 */
export const DEFAULT_EVIDENCE_WEIGHTS: EvidenceWeights = Object.freeze({
  sources: Object.freeze({ ytm: 1, spotify: 1, lastfm: 0.9, listenbrainz: 0.85, library: 0 }),
  parts: Object.freeze({ radio: 1, station: 0.9, 'similar-artists': 0.75, home: 0.8 }),
  otherSource: 0.8,
  otherPart: 0.8,
})

/** Options for {@link poolCandidates}. */
export interface PoolOptions {
  /** The catalog mode: tracks it does not let recommendations hold are left out. */
  readonly mode: CatalogMode
  /** How much a candidate's seed counts, from 0 to 1. Default: 1 for every seed. */
  readonly seedWeight?: (seed: RecSeed) => number
  /** How much each source and part counts. Default {@link DEFAULT_EVIDENCE_WEIGHTS}. */
  readonly evidence?: EvidenceWeights
}

/** Most tags a pooled song keeps. */
const MAX_TAGS = 10

/**
 * Sources whose tracks play most directly, best first: local files and the sources with audio
 * of their own, then plain YouTube (videos), then Spotify, which needs matching. Plugin sources
 * come last.
 */
const SOURCE_PREFERENCE = ['local', 'ytm', 'archive', 'jamendo', 'yt', 'spotify'] as const

function sourceRank(source: string): number {
  const index = (SOURCE_PREFERENCE as readonly string[]).indexOf(source)
  return index < 0 ? SOURCE_PREFERENCE.length : index
}

/**
 * Whether recommendations may hold `track` in `mode`: songs only in Music mode (an official
 * video plays only through its song, which a recommendation should name itself), and anything
 * but episodes in Music + Video. The rule of `@fxm/sources/recommend`'s `tracksForMode`.
 */
export function fitsMode(track: Pick<Track, 'kind' | 'songId' | 'id'>, mode: CatalogMode): boolean {
  return mode === 'music' ? isPlayable(track, 'music') : modePolicy(track, mode) !== 'hidden'
}

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** Combines independent strengths: `1 − Π(1 − s)`, in a fixed order so ties stay ties. */
export function combineStrengths(strengths: readonly number[]): number {
  let miss = 1
  for (const strength of [...strengths].sort((a, b) => b - a)) miss *= 1 - clamp01(strength)
  return 1 - miss
}

/** Compares strings for sorting, so the order never depends on the locale. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** One listing while pooling. */
interface Listing {
  index: number
  keys: string[]
  track?: Track
  title: string
  artists: string[]
  durationMs?: number
  youtubeId?: string
  evidence: Evidence
}

/** A minimal union-find over listing indices. */
function createGroups(size: number) {
  const parent = Array.from({ length: size }, (_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] as number
    let node = index
    while (parent[node] !== root) {
      const next = parent[node] as number
      parent[node] = root
      node = next
    }
    return root
  }
  return {
    find,
    union(a: number, b: number) {
      const rootA = find(a)
      const rootB = find(b)
      // The smaller index wins, so a group's root is its first listing.
      if (rootA < rootB) parent[rootB] = rootA
      else if (rootB < rootA) parent[rootA] = rootB
    },
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function evidenceOf(
  candidate: RecCandidate,
  options: PoolOptions,
  weights: EvidenceWeights,
): Evidence {
  const source = typeof candidate.source === 'string' ? candidate.source : ''
  const part = typeof candidate.part === 'string' ? candidate.part : ''
  const seed = candidate.seed
  const sourceWeight = Object.hasOwn(weights.sources, source)
    ? (weights.sources[source] as number)
    : weights.otherSource
  const partWeight = Object.hasOwn(weights.parts, part)
    ? (weights.parts[part] as number)
    : weights.otherPart
  const seedWeight = options.seedWeight === undefined ? 1 : clamp01(options.seedWeight(seed))
  const score = clamp01(candidate.score)
  return {
    source,
    part,
    seed,
    seedKey: seedKey(seed) ?? '',
    rank:
      typeof candidate.rank === 'number' && Number.isFinite(candidate.rank) ? candidate.rank : 0,
    score,
    strength: clamp01(score * clamp01(sourceWeight) * clamp01(partWeight) * seedWeight),
  }
}

/** The listing of a track or song-search candidate, or `undefined` when it can't be pooled. */
function listingOf(
  candidate: RecCandidate,
  index: number,
  options: PoolOptions,
  weights: EvidenceWeights,
): Listing | undefined {
  if (typeof candidate?.seed !== 'object' || candidate.seed === null) return undefined
  if (candidate.type === 'track') {
    const track = candidate.track
    if (typeof track !== 'object' || track === null || !fitsMode(track, options.mode)) {
      return undefined
    }
    const keys = trackKeys(track)
    if (keys.length === 0 || !isText(track.title)) return undefined
    const listing: Listing = {
      index,
      keys,
      track,
      title: track.title,
      artists: Array.isArray(track.artists)
        ? track.artists.map((artist) => artist?.name).filter(isText)
        : [],
      evidence: evidenceOf(candidate, options, weights),
    }
    if (typeof track.durationMs === 'number') listing.durationMs = track.durationMs
    return listing
  }
  if (candidate.type === 'song-search') {
    const artists = Array.isArray(candidate.artists) ? candidate.artists.filter(isText) : []
    const song = songIdentity(candidate.title, artists)
    if (song === undefined) return undefined
    const listing: Listing = {
      index,
      keys: [song],
      title: candidate.title,
      artists,
      evidence: evidenceOf(candidate, options, weights),
    }
    if (typeof candidate.durationMs === 'number') listing.durationMs = candidate.durationMs
    if (isText(candidate.youtubeId)) listing.youtubeId = candidate.youtubeId
    return listing
  }
  return undefined
}

/**
 * Orders listings best first, the same whatever order they came in: a track before a song
 * search, then by source, a cover, the evidence's strength, and finally by key and rank.
 */
function byListing(a: Listing, b: Listing): number {
  if ((a.track === undefined) !== (b.track === undefined)) return a.track === undefined ? 1 : -1
  if (a.track !== undefined && b.track !== undefined) {
    const bySource = sourceRank(a.track.source) - sourceRank(b.track.source)
    if (bySource !== 0) return bySource
    const aArt = a.track.artwork?.length > 0
    const bArt = b.track.artwork?.length > 0
    if (aArt !== bArt) return aArt ? -1 : 1
  }
  return (
    b.evidence.strength - a.evidence.strength ||
    compareKeys(a.keys[0] ?? '', b.keys[0] ?? '') ||
    compareKeys(a.title, b.title) ||
    a.evidence.rank - b.evidence.rank ||
    compareKeys(a.evidence.seedKey, b.evidence.seedKey)
  )
}

/** The evidence of a group: one per list (source, part and seed), the strongest listing of each. */
function mergeEvidence(evidence: readonly Evidence[]): Evidence[] {
  const byList = new Map<string, Evidence>()
  for (const one of evidence) {
    const list = `${one.source}|${one.part}|${one.seedKey}`
    const kept = byList.get(list)
    if (
      kept === undefined ||
      one.strength > kept.strength ||
      (one.strength === kept.strength && one.rank < kept.rank)
    ) {
      byList.set(list, one)
    }
  }
  return [...byList.values()].sort(
    (a, b) =>
      b.strength - a.strength ||
      compareKeys(a.source, b.source) ||
      compareKeys(a.part, b.part) ||
      compareKeys(a.seedKey, b.seedKey),
  )
}

/** The pooled song of one group of listings. */
function songOf(group: readonly Listing[]): PooledSong {
  const ordered = [...group].sort(byListing)
  const best = ordered[0] as Listing
  const keys = [...new Set(ordered.flatMap((listing) => listing.keys))]
  const evidence = mergeEvidence(group.map((listing) => listing.evidence))
  const tags = new Set<string>()
  let popularity: number | undefined
  const durationMs = ordered.find((listing) => listing.durationMs !== undefined)?.durationMs
  const artworkFrom = ordered.find((listing) => (listing.track?.artwork?.length ?? 0) > 0)?.track
  for (const listing of ordered) {
    const track = listing.track
    if (track === undefined) continue
    for (const tag of Array.isArray(track.tags) ? track.tags : []) {
      const key = typeof tag === 'string' ? tagAffinityKey(tag) : undefined
      if (key !== undefined) tags.add(key)
    }
    if (typeof track.popularity === 'number' && Number.isFinite(track.popularity)) {
      popularity = Math.max(popularity ?? -Infinity, track.popularity)
    }
  }
  let track = best.track
  if (track !== undefined && !(track.artwork?.length > 0) && artworkFrom !== undefined) {
    // Another source's cover is better than none, e.g. Spotify's for a song without art.
    track = { ...track, artwork: artworkFrom.artwork }
  }
  const mainKey = track !== undefined ? (best.keys[0] as string) : (keys[0] as string)
  const song: {
    -readonly [K in keyof PooledSong]: PooledSong[K]
  } = {
    key: mainKey,
    keys: [mainKey, ...keys.filter((key) => key !== mainKey)],
    title: best.title,
    artists: best.artists,
    artistKeys: artistKeysOf(best.artists),
    tags: [...tags].sort(compareKeys).slice(0, MAX_TAGS),
    evidence,
    similarity: combineStrengths(evidence.map((one) => one.strength)),
  }
  if (track !== undefined) song.track = track
  if (durationMs !== undefined) song.durationMs = durationMs
  if (track === undefined && best.youtubeId !== undefined) song.youtubeId = best.youtubeId
  if (popularity !== undefined) song.popularity = popularity
  return song
}

/**
 * Whether `a` is a better listing of an artist than `b`: one with an ID, then with more photos,
 * then by ID and name, so the choice never depends on the order the listings came in.
 */
function betterArtist(a: RecArtist, b: RecArtist): boolean {
  if ((a.id === undefined) !== (b.id === undefined)) return a.id !== undefined
  const photos = (a.artwork?.length ?? 0) - (b.artwork?.length ?? 0)
  if (photos !== 0) return photos > 0
  return (compareKeys(a.id ?? '', b.id ?? '') || compareKeys(a.name, b.name)) < 0
}

/**
 * The artist candidates of `candidates`, pooled by artist: one per artist, with every listing as
 * evidence. Other candidates are ignored.
 */
export function pooledArtistCandidates(
  candidates: Iterable<RecCandidate>,
  options: PoolOptions,
): PooledArtist[] {
  const weights = options.evidence ?? DEFAULT_EVIDENCE_WEIGHTS
  const groups = new Map<string, { artist: RecArtist; evidence: Evidence[] }>()
  for (const candidate of candidates) {
    if (candidate?.type !== 'artist' || typeof candidate.seed !== 'object') continue
    const artist = candidate.artist
    const key = artistKeyOf(artist?.name)
    if (key === undefined) continue
    const evidence = evidenceOf(candidate, options, weights)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { artist, evidence: [evidence] })
    else {
      group.evidence.push(evidence)
      if (betterArtist(artist, group.artist)) group.artist = artist
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const evidence = mergeEvidence(group.evidence)
      return {
        key,
        artist: group.artist,
        evidence,
        similarity: combineStrengths(evidence.map((one) => one.strength)),
      }
    })
    .sort((a, b) => b.similarity - a.similarity || compareKeys(a.key, b.key))
}

/**
 * Pools candidates into songs and artists (see the module documentation). Candidates that can't
 * be read, tracks the mode leaves out, and listings of a radio's own seed song are dropped, so
 * data from outside can't break the engine and a radio never recommends what it started from.
 */
export function poolCandidates(
  candidates: Iterable<RecCandidate>,
  options: PoolOptions,
): CandidatePool {
  const weights = options.evidence ?? DEFAULT_EVIDENCE_WEIGHTS
  const all = [...candidates]
  const listings: Listing[] = []
  for (const candidate of all) {
    const listing = listingOf(candidate, listings.length, options, weights)
    if (listing === undefined) continue
    const own = new Set(seedSongKeys(listing.evidence.seed))
    if (listing.keys.some((key) => own.has(key))) continue
    listing.index = listings.length
    listings.push(listing)
  }

  const groups = createGroups(listings.length)
  const firstWithKey = new Map<string, number>()
  for (const listing of listings) {
    for (const key of listing.keys) {
      const first = firstWithKey.get(key)
      if (first === undefined) firstWithKey.set(key, listing.index)
      else groups.union(first, listing.index)
    }
  }
  const members = new Map<number, Listing[]>()
  for (const listing of listings) {
    const root = groups.find(listing.index)
    const group = members.get(root)
    if (group === undefined) members.set(root, [listing])
    else group.push(listing)
  }

  const songs = [...members.values()]
    .map(songOf)
    .sort((a, b) => b.similarity - a.similarity || compareKeys(a.key, b.key))
  return { songs, artists: pooledArtistCandidates(all, options) }
}
