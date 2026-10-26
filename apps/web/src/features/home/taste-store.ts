/**
 * What the user told Home about their taste in the cold-start onboarding: the artists and genres
 * they picked, or that they would rather not say for now. Kept in `localStorage` on this device,
 * like the other settings; the engine counts the picks like likes (`TastePicks` in `@fxm/core`),
 * so they fade as real listening takes over.
 *
 * @module
 */

import { type EntityId, isEntityId, type PickedArtist, type TastePicks } from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const TASTE_STORAGE_KEY = 'fxm.home.taste.v1'

/** Most artists and genres kept, and the longest name. */
export const MAX_PICKED_ARTISTS = 50
export const MAX_PICKED_GENRES = 30
const MAX_NAME_LENGTH = 100

/** The persisted part. */
export interface Taste {
  /** The onboarding picks, once the user made them. */
  picks?: TastePicks
  /** When the user put the onboarding off ("Not now"). */
  dismissedAt?: number
}

export interface TasteState extends Taste {
  /** Saves the picks, made `at` (epoch milliseconds). */
  savePicks(
    picks: { artists: readonly PickedArtist[]; genres: readonly string[] },
    at: number,
  ): void
  /** Forgets the picks: Home grows from what the user plays only. */
  clearPicks(): void
  /** Puts the onboarding off. */
  dismiss(at: number): void
  /** Brings the onboarding back. */
  reopen(): void
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\s+/gu, ' ').trim()
  return name === '' ? undefined : name.slice(0, MAX_NAME_LENGTH)
}

/** Picked artists and genres, cleaned: names trimmed, each once (ignoring case), bounded. */
export function cleanPicks(picks: { artists?: readonly unknown[]; genres?: readonly unknown[] }): {
  artists: PickedArtist[]
  genres: string[]
} {
  const artists: PickedArtist[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(picks.artists) ? picks.artists : []) {
    const record =
      typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const name = cleanName(record.name)
    if (name === undefined || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const id = record.id
    artists.push(isEntityId(id, 'artist') ? { name, id: id as EntityId<'artist'> } : { name })
    if (artists.length >= MAX_PICKED_ARTISTS) break
  }
  const genres: string[] = []
  for (const item of Array.isArray(picks.genres) ? picks.genres : []) {
    const name = cleanName(item)
    if (name === undefined || genres.some((genre) => genre.toLowerCase() === name.toLowerCase())) {
      continue
    }
    genres.push(name)
    if (genres.length >= MAX_PICKED_GENRES) break
  }
  return { artists, genres }
}

/** Keeps the valid parts of a stored taste. */
export function sanitizeTaste(value: unknown): Taste {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const taste: Taste = {}
  const picks = stored.picks as Record<string, unknown> | undefined
  if (typeof picks === 'object' && picks !== null && isTime(picks.at)) {
    const clean = cleanPicks(picks as { artists?: unknown[]; genres?: unknown[] })
    if (clean.artists.length > 0 || clean.genres.length > 0)
      taste.picks = { ...clean, at: picks.at }
  }
  if (isTime(stored.dismissedAt)) taste.dismissedAt = stored.dismissedAt
  return taste
}

/** Creates a taste store persisted to Web Storage (one per app; tests make their own). */
export function createTasteStore(storage?: () => Storage | undefined) {
  return create<TasteState>()(
    persist(
      (set) => ({
        savePicks: (picks, at) => {
          const clean = cleanPicks(picks)
          set({ picks: { ...clean, at } })
        },
        clearPicks: () =>
          set((state) => {
            const { picks: _picks, ...rest } = state
            return rest
          }, true),
        dismiss: (at) => set({ dismissedAt: at }),
        reopen: () =>
          set((state) => {
            const { dismissedAt: _dismissed, ...rest } = state
            return rest
          }, true),
      }),
      {
        name: TASTE_STORAGE_KEY,
        version: 1,
        storage: createSafeStorage<Taste>(storage),
        partialize: ({ picks, dismissedAt }) => ({
          ...(picks === undefined ? {} : { picks }),
          ...(dismissedAt === undefined ? {} : { dismissedAt }),
        }),
        migrate: (persisted) => sanitizeTaste(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeTaste(persisted) }),
      },
    ),
  )
}

/** The app's taste store. */
export const useTasteStore = createTasteStore()
