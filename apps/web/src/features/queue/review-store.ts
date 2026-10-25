import {
  type AudioCandidate,
  isEntityId,
  isSourceId,
  type MatchSignals,
  type Track,
  type TrackKind,
} from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The queue's review list: tracks whose audio is only a Suggest-band match (FXM isn't sure it
 * found the right recording), each with its best guess, and the "Play best guesses" setting.
 *
 * The playback policy (stage 2.3) reports the tracks as it matches them; the user approves a
 * best guess or picks another version, which removes the entry. Entries are keyed by track ID,
 * so a track queued twice is reviewed once, and are saved with the queue, so the list survives
 * a reload without matching the queue again.
 */
export interface QueueReviewState {
  /** The best guess of each track that needs review, by track ID. */
  entries: Readonly<Record<string, AudioCandidate>>
  /**
   * "Play best guesses": Suggest-band matches play without a review. Off by default, so queues
   * skip them until the user reviews them.
   */
  playBestGuesses: boolean
  /** Records that `track` needs review, with the match that would play. */
  report: (track: Track, bestGuess: AudioCandidate) => void
  /** Removes the entry of the track with `trackId`: it was approved, or replaced. */
  dismiss: (trackId: string) => void
  /** Keeps only the entries of the tracks in `trackIds`, e.g. the tracks still in the queue. */
  keepOnly: (trackIds: ReadonlySet<string>) => void
  /** Removes every entry, e.g. when the catalog mode changes and matches are redone. */
  clear: () => void
  setPlayBestGuesses: (on: boolean) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const REVIEW_STORAGE_KEY = 'fxm.queue-review.v1'
const REVIEW_VERSION = 1

type Persisted = Pick<QueueReviewState, 'entries' | 'playBestGuesses'>

const TRACK_KINDS: ReadonlySet<string> = new Set<TrackKind>([
  'song',
  'music-video',
  'video',
  'episode',
])

function isTrackKind(value: unknown): value is TrackKind {
  return typeof value === 'string' && TRACK_KINDS.has(value)
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function cleanSignals(value: unknown): MatchSignals | undefined {
  if (!isRecord(value)) return undefined
  const { isrcVerified, sourceAlbumMatch, releaseId, releaseYear, label } = value
  if (typeof isrcVerified !== 'boolean' || typeof sourceAlbumMatch !== 'boolean') return undefined
  return {
    isrcVerified,
    sourceAlbumMatch,
    ...(typeof releaseId === 'string' && releaseId !== '' ? { releaseId } : {}),
    ...(Number.isSafeInteger(releaseYear) && (releaseYear as number) > 0
      ? { releaseYear: releaseYear as number }
      : {}),
    ...(typeof label === 'string' ? { label } : {}),
  }
}

/**
 * A clean copy of a stored {@link AudioCandidate}, or `undefined` when a required field is
 * missing or malformed. Malformed optional fields are dropped; unknown fields are never copied.
 */
export function cleanCandidate(value: unknown): AudioCandidate | undefined {
  if (!isRecord(value)) return undefined
  const { source, ref, kind, title, artists, durationMs, confidence, evidence } = value
  if (!isSourceId(source) || typeof ref !== 'string' || ref === '') return undefined
  if (!isTrackKind(kind) || typeof title !== 'string') return undefined
  if (!isNonNegative(confidence) || confidence > 1) return undefined
  if (!isStringArray(artists) || !isStringArray(evidence)) return undefined
  const signals = cleanSignals(value.signals)
  return {
    source,
    ref,
    kind,
    title,
    artists: [...artists],
    ...(isNonNegative(durationMs) ? { durationMs } : {}),
    confidence,
    evidence: [...evidence],
    ...(signals === undefined ? {} : { signals }),
  }
}

/** Valid persisted review state from an untrusted value: anything malformed is dropped. */
export function sanitizeReview(value: unknown): Persisted {
  const stored = isRecord(value) ? value : {}
  const entries: Record<string, AudioCandidate> = {}
  if (isRecord(stored.entries)) {
    for (const [trackId, raw] of Object.entries(stored.entries)) {
      const candidate = cleanCandidate(raw)
      if (isEntityId(trackId, 'track') && candidate !== undefined) entries[trackId] = candidate
    }
  }
  return { entries, playBestGuesses: stored.playBestGuesses === true }
}

function without(
  entries: Readonly<Record<string, AudioCandidate>>,
  keep: (trackId: string) => boolean,
): Readonly<Record<string, AudioCandidate>> {
  const kept = Object.entries(entries).filter(([trackId]) => keep(trackId))
  return kept.length === Object.keys(entries).length ? entries : Object.fromEntries(kept)
}

export interface QueueReviewStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the review store, persisted to Web Storage (one per app; tests make their own). */
export function createQueueReviewStore({ storage }: QueueReviewStoreOptions = {}) {
  return create<QueueReviewState>()(
    persist(
      (set, get) => {
        /** Keeps the entries `keep` accepts; writes (and saves) only when that drops one. */
        const filter = (keep: (trackId: string) => boolean) => {
          const { entries } = get()
          const kept = without(entries, keep)
          if (kept !== entries) set({ entries: kept })
        }
        return {
          entries: {},
          playBestGuesses: false,
          report: (track, bestGuess) =>
            set((state) => ({ entries: { ...state.entries, [track.id]: bestGuess } })),
          dismiss: (trackId) => filter((id) => id !== trackId),
          keepOnly: (trackIds) => filter((id) => trackIds.has(id)),
          clear: () => filter(() => false),
          setPlayBestGuesses: (playBestGuesses) => set({ playBestGuesses }),
        }
      },
      {
        name: REVIEW_STORAGE_KEY,
        version: REVIEW_VERSION,
        storage: createSafeStorage<Persisted>(storage),
        partialize: ({ entries, playBestGuesses }) => ({ entries, playBestGuesses }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeReview(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeReview(persisted) }),
      },
    ),
  )
}

export type QueueReviewStore = ReturnType<typeof createQueueReviewStore>

export const useQueueReviewStore: QueueReviewStore = createQueueReviewStore()
