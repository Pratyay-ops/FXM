/**
 * Which seeds to collect recommendations for: the few tracks and artists that Home's shelves
 * grow from. The app asks the recommendation sources (stage 3.2's collector) once per seed, for
 * the parts each seed needs, so the plan also bounds how many requests a Home costs.
 *
 * | Purpose | Seeds |
 * |---|---|
 * | `because` | The latest plays of the last 14 days that the user didn't skip, one per artist ("Because you listened to X") |
 * | `mix` | The user's top artists, one Daily Mix each: seeded with the artist's favourite track, else the artist |
 * | `discover` | The top two artists, also asking for similar artists (and Last.fm's station for the first) |
 * | `quick-picks` | The two favourite tracks |
 *
 * Onboarding picks count as artists with an affinity, so after a cold start they seed the mixes
 * and Discover.
 *
 * @module
 */

import { entityKey, isEntityId } from '../ids'
import type { CatalogMode } from '../mode'
import type { Track } from '../model'
import type { RadioSeed } from '../providers'
import { artistRef, recSeedOf, seedArtistKey, seedKey } from './identity'
import { fitsMode } from './pool'
import { likedEnough, type TasteIndex, type TrackTaste } from './taste'
import type { RecSeed } from './types'

/** What a seed is collected for. */
export type SeedPurpose = 'because' | 'mix' | 'discover' | 'quick-picks'

/** A part of a collection: the recommendation sources' calls (stage 3.2's `RecommendationPart`). */
export type SeedPart = 'radio' | 'station' | 'similar-artists'

/** One seed to collect recommendations for. */
export interface PlannedSeed {
  /** The seed's key (`seedKey`): candidates collected for it carry the same key. */
  readonly key: string
  /** What to hand the collector: a track or an artist. */
  readonly seed: RadioSeed
  /** How candidates will name it. */
  readonly ref: RecSeed
  /** The parts to collect. */
  readonly parts: readonly SeedPart[]
  /** What the shelves use it for. */
  readonly purposes: readonly SeedPurpose[]
  /** How much the user likes it, from 0.5 to 1: scales what its candidates count. */
  readonly weight: number
}

/** Options for {@link planSeeds}. */
export interface SeedPlanOptions {
  /** The catalog mode: a track seed must fit it. */
  readonly mode: CatalogMode
  /** Most seeds in all. Default 8. */
  readonly maxSeeds?: number
  /** Most "Because you listened" seeds. Default 3. */
  readonly because?: number
  /** Only plays this recent seed "Because you listened". Default 14 days. */
  readonly becauseWindowMs?: number
  /** Most Daily Mix seeds. Default 6. */
  readonly mixes?: number
  /** Seeds that also ask for similar artists, for Discover. Default 2. */
  readonly discover?: number
  /** Seeds that also ask for Last.fm's station (which classifies its videos). Default 1. */
  readonly stations?: number
  /** Favourite tracks that seed Quick picks. Default 2. */
  readonly quickPicks?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A plan entry while it is being built. */
interface Draft {
  key: string
  seed: RadioSeed
  ref: RecSeed
  parts: Set<SeedPart>
  purposes: Set<SeedPurpose>
  weight: number
}

/** The weight of a seed from its affinity: `0.5 + 0.5 · norm`. */
function weightOf(norm: number): number {
  return 0.5 + 0.5 * Math.min(1, Math.max(0, Number.isFinite(norm) ? norm : 0))
}

/** The track a seed can start from: one with metadata, fitting the mode, liked enough. */
function usableTrack(taste: TrackTaste, mode: CatalogMode): boolean {
  return taste.track !== undefined && fitsMode(taste.track, mode) && likedEnough(taste)
}

/**
 * How much `seed` counts for the candidates collected for it, from 0.5 to 1: half for any seed,
 * plus half of how much the user likes it (a track's affinity, or its main artist's when that
 * is stronger; an artist's affinity).
 */
export function seedWeight(taste: TasteIndex, seed: RecSeed): number {
  if (typeof seed !== 'object' || seed === null) return weightOf(0)
  const main = taste.artist(seedArtistKey(seed))?.norm ?? 0
  if (seed.type !== 'track') return weightOf(main)
  const track = isEntityId(seed.id, 'track') ? taste.track([entityKey(seed.id)]) : undefined
  return weightOf(Math.max(track?.norm ?? 0, main))
}

/** The key of a track's main artist. */
function mainArtistOf(track: Track): string | undefined {
  return seedArtistKey(recSeedOf(track))
}

/**
 * Plans the seeds of a Home (see the module documentation), most important first. Every seed is
 * collected for `radio`; mix and Discover seeds also for `similar-artists`, and the first
 * Discover seed for `station`. Duplicates merge, so a favourite track that is also a recent play
 * is collected once.
 */
export function planSeeds(taste: TasteIndex, options: SeedPlanOptions): PlannedSeed[] {
  const {
    mode,
    maxSeeds = 8,
    because = 3,
    becauseWindowMs = 14 * DAY_MS,
    mixes = 6,
    discover = 2,
    stations = 1,
    quickPicks = 2,
  } = options
  const drafts = new Map<string, Draft>()
  const order: string[] = []

  const add = (seed: RadioSeed, purpose: SeedPurpose, parts: readonly SeedPart[], norm: number) => {
    const ref = recSeedOf(seed)
    const key = seedKey(ref)
    if (key === undefined) return
    let draft = drafts.get(key)
    if (draft === undefined) {
      if (drafts.size >= maxSeeds) return
      draft = { key, seed, ref, parts: new Set(), purposes: new Set(), weight: weightOf(norm) }
      drafts.set(key, draft)
      order.push(key)
    }
    draft.purposes.add(purpose)
    for (const part of parts) draft.parts.add(part)
    draft.weight = Math.max(draft.weight, weightOf(norm))
  }

  // Because you listened: the latest plays that weren't skipped, one per main artist.
  const artistsSeen = new Set<string>()
  let becauseCount = 0
  for (const play of taste.recent) {
    if (becauseCount >= because || taste.now - play.playedAt > becauseWindowMs) break
    const track = play.track
    if (track === undefined || !fitsMode(track, mode)) continue
    const known = taste.track([entityKey(play.trackId)])
    if (known === undefined || !likedEnough(known)) continue
    const artist = mainArtistOf(track)
    if (artist === undefined || artistsSeen.has(artist)) continue
    artistsSeen.add(artist)
    add(track, 'because', ['radio'], known.norm)
    becauseCount++
  }

  // Mixes and Discover: the top artists, by their favourite track when there is one.
  const topArtists = taste.artists.filter(likedEnough)
  topArtists.slice(0, mixes).forEach((artist, index) => {
    const favourite = taste.tracks.find(
      (track) => usableTrack(track, mode) && mainArtistOf(track.track as Track) === artist.key,
    )
    const id = artist.ids.find((one) => isEntityId(one, 'artist'))
    const seed: RadioSeed = favourite?.track ?? artistRef(artist.label, id)
    const parts: SeedPart[] = ['radio']
    if (index < discover) parts.push('similar-artists')
    if (index < stations) parts.push('station')
    add(seed, 'mix', parts, artist.norm)
    if (index < discover) add(seed, 'discover', parts, artist.norm)
  })

  // Quick picks: the favourite tracks.
  taste.tracks
    .filter((track) => usableTrack(track, mode))
    .slice(0, quickPicks)
    .forEach((track) => {
      add(track.track as Track, 'quick-picks', ['radio'], track.norm)
    })

  return order.map((key) => {
    const draft = drafts.get(key) as Draft
    return {
      key,
      seed: draft.seed,
      ref: draft.ref,
      parts: [...draft.parts],
      purposes: [...draft.purposes],
      weight: draft.weight,
    }
  })
}
