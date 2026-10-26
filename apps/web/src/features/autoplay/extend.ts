/**
 * One extension of the queue by the autoplay radio (stage 3.4): the library reads and the one
 * network call around the pure radio of `@fxm/core` (`packages/core/src/recommend/radio.ts`).
 *
 * 1. **The taste** from the library (stage 3.1's affinity, the recent plays, the onboarding
 *    picks), read afresh for every extension, so the likes and skips since the last one count.
 * 2. **The seeds:** the last 5 plays of the session (`planRadioSeeds`), the track playing now
 *    first.
 * 3. **One radio fetch:** the radio of the heaviest seed whose radio isn't cached
 *    (`nextRadioSeed`), from the recommendation sources (stage 3.2's collector), at the request
 *    budget's `prefetch` priority (stage 1.2), within {@link EXTENSION_DEADLINE_MS}. Collections
 *    go into Home's cache (`collectionsOf`) for half an hour, so a seed's radio is fetched once
 *    for the radio and Home's "Because you listened" alike.
 * 4. **The batch** (`buildRadioBatch`) from the radios of every seed at hand, with the affinity
 *    of everything they suggest (`completeProfile`), so a song or artist the user skips is
 *    known as one.
 *
 * Loaded only when the queue first runs low with autoplay on, so the library and the engine
 * stay out of the app's first load.
 *
 * @module
 */

import {
  buildRadioBatch,
  currentQueueItem,
  indexTaste,
  nextRadioSeed,
  type PlannedSeed,
  planRadioSeeds,
  type QueueState,
  type RadioPick,
  type RandomSource,
  type RecCandidate,
  type TastePicks,
  upcomingQueueItems,
} from '@fxm/core'
import { getLibrary, type LibraryRepo } from '../../db/repo'
import {
  type CollectionCache,
  collectionKey,
  collectionsOf,
  completeProfile,
  FEED_LIMITS,
  loadTasteProfile,
  type ProfileLimits,
  skipsRadio,
} from '../home/feed'
import { canRecommend, type HomeServices } from '../home/services'
import { useTasteStore } from '../home/taste-store'

/** How long the one radio fetch of an extension may take; the batch is built from what came. */
export const EXTENSION_DEADLINE_MS = 8_000

/**
 * A collector that misses its own deadline is cut off at this many times it: late enough that
 * one which keeps it hands over what arrived, never later.
 */
const CUT_OFF_FACTOR = 1.25

/**
 * How much of the library an extension reads: the recent plays for the seeds and for "no
 * repeats within N tracks" (50), and the top of the affinity to weigh likes against. The
 * affinity of the songs and artists the radios suggest is read as well (`completeProfile`).
 */
export const RADIO_PROFILE_LIMITS: ProfileLimits = Object.freeze({
  tracks: 100,
  artists: 120,
  tags: 60,
  recent: 100,
})

/** What one extension is planned from. */
export interface ExtensionRequest {
  /** The queue to extend, as it is now. */
  readonly queue: QueueState
  /** How many tracks to add. */
  readonly count: number
  /** The recommendation sources and what the platform reaches (Home's services). */
  readonly services: HomeServices
  /** The library. */
  readonly repo: LibraryRepo
  /** The onboarding picks. */
  readonly picks?: TastePicks
  /** Keys of songs to leave out: the radio's songs the user removed from the queue. */
  readonly exclude?: Iterable<string>
  /** The time, as epoch milliseconds. */
  readonly now: number
  /** Noise for the scores. Default: the engine's, seeded with the time. */
  readonly random?: RandomSource
  /** Cancels the extension: it rejects with the signal's reason. */
  readonly signal?: AbortSignal
  /** How long the radio fetch may take. Default {@link EXTENSION_DEADLINE_MS}. */
  readonly deadlineMs?: number
  /** Where seeds' radios are kept. Default: Home's cache for these recommendation sources. */
  readonly cache?: CollectionCache
}

/** A planned extension. */
export interface Extension {
  /** The tracks to add, in order, each with the seed its radio grew from. */
  readonly picks: readonly RadioPick[]
  /** The seed whose radio was fetched, if one was: at most one per extension. */
  readonly fetched?: PlannedSeed
}

const NOTHING: Extension = Object.freeze({ picks: [] })

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason
}

/**
 * The radio of `seed`: its candidates, kept in `cache` when every source answered. Anything but
 * a cancellation (a failure, the deadline) gives what arrived, or nothing.
 */
async function fetchRadio(
  request: ExtensionRequest,
  seed: PlannedSeed,
  key: string,
  cache: CollectionCache,
): Promise<readonly RecCandidate[]> {
  const { services, signal, now } = request
  const recommendations = services.recommendations
  if (recommendations === undefined) return []
  const deadlineMs = request.deadlineMs ?? EXTENSION_DEADLINE_MS
  const abort = new AbortController()
  const onAbort = () => abort.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), deadlineMs * CUT_OFF_FACTOR)
  // Settles when the fetch is cut off or cancelled, even if the collector doesn't heed it.
  const cutOff = new Promise<never>((_, reject) => {
    abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
  })
  cutOff.catch(() => {})
  try {
    const ctx = services.sources.context({
      mode: request.queue.mode,
      priority: 'prefetch',
      signal: abort.signal,
    })
    const collecting = recommendations.collect(seed.seed, ctx, {
      parts: seed.parts,
      limit: FEED_LIMITS.perSource,
      deadlineMs,
    })
    // What it does after the cut-off is no one's business.
    collecting.catch(() => {})
    const { candidates, outcomes = [] } = await Promise.race([collecting, cutOff])
    // Only whole collections are kept: a source that failed or was late may answer next time.
    // Marked as Home marks its own, so a Home build that reuses one knows if the radio skipped it.
    if (
      outcomes.every((outcome) => outcome.status !== 'failed' && outcome.status !== 'timed-out')
    ) {
      cache.set(key, { candidates, radioSkipped: outcomes.some(skipsRadio) }, now)
    }
    return candidates
  } catch {
    throwIfAborted(signal)
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Plans one extension of `request.queue` (see the module documentation). Resolves with no
 * picks when there is nothing to grow from or the sources can't run; rejects only when
 * cancelled, or when the library can't be read.
 */
export async function planExtension(request: ExtensionRequest): Promise<Extension> {
  const { services, queue, repo, now, signal } = request
  const recommendations = services.recommendations
  const reach = services.sources.getSnapshot()
  if (recommendations === undefined || !canRecommend(services, reach) || request.count <= 0) {
    return NOTHING
  }
  const profile = await loadTasteProfile(repo, request.picks, RADIO_PROFILE_LIMITS)
  throwIfAborted(signal)
  const taste = indexTaste(profile, now)
  const current = currentQueueItem(queue)?.track
  const seeds = planRadioSeeds(taste, {
    mode: queue.mode,
    ...(current === undefined ? {} : { current }),
  })
  if (seeds.length === 0) return NOTHING

  const cache = request.cache ?? collectionsOf(recommendations)
  const keyOf = (seed: PlannedSeed) => collectionKey(seed, queue.mode, reach)
  const fetched = nextRadioSeed(seeds, (seed) => cache.get(keyOf(seed), now) !== undefined)
  const fresh =
    fetched === undefined ? [] : await fetchRadio(request, fetched, keyOf(fetched), cache)
  throwIfAborted(signal)
  const candidates = seeds.flatMap((seed) =>
    seed === fetched ? fresh : (cache.get(keyOf(seed), now)?.candidates ?? []),
  )

  const completed = await completeProfile(repo, profile, candidates)
  throwIfAborted(signal)
  const batch = buildRadioBatch({
    profile: completed,
    taste: completed === profile ? taste : indexTaste(completed, now),
    seeds,
    candidates,
    queued: queue.items.map((item) => item.track),
    upcoming: upcomingQueueItems(queue).map((item) => item.track),
    ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
    mode: queue.mode,
    now,
    ...(request.random === undefined ? {} : { random: request.random }),
    count: request.count,
  })
  return { picks: batch.picks, ...(fetched === undefined ? {} : { fetched }) }
}

/** What the app's autoplay asks of {@link planAppExtension}. */
export type AppExtensionRequest = Omit<ExtensionRequest, 'repo' | 'picks'>

/** {@link planExtension} with the app's library and onboarding picks. */
export function planAppExtension(request: AppExtensionRequest): Promise<Extension> {
  const picks = useTasteStore.getState().picks
  return planExtension({
    ...request,
    repo: getLibrary(),
    ...(picks === undefined ? {} : { picks }),
  })
}
