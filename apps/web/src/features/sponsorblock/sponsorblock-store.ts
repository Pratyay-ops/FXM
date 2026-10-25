import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The SponsorBlock setting (stage 8.7): whether FXM skips the non-music parts of videos in
 * Music + Video mode, and where the offer to turn it on stands. Opt-in: everything starts
 * `false`. It has its own key, next to the other settings.
 */
export interface SponsorBlockState {
  /** Whether to skip the non-music parts of videos. Off by default. */
  enabled: boolean
  /**
   * Whether the user has made a choice: answered the offer, or set the switch in Settings. The
   * offer never shows again after that.
   */
  offered: boolean
  /**
   * Whether a session has shown the offer. Only that first Music + Video session shows it (see
   * {@link isOfferSession}); later ones leave the choice to Settings.
   */
  offerShown: boolean
  /** Turns skipping on or off. A choice, so the offer won't show again. */
  setEnabled: (enabled: boolean) => void
  /** Answers the offer with "No thanks": it won't show again, and skipping stays off. */
  dismissOffer: () => void
  /** Notes that the offer showed. */
  markOfferShown: () => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const SPONSORBLOCK_STORAGE_KEY = 'fxm.sponsorblock.v1'
const SPONSORBLOCK_VERSION = 1

type Persisted = Pick<SponsorBlockState, 'enabled' | 'offered' | 'offerShown'>

/** Valid persisted state from an untrusted value: `true` only where it says `true`. */
export function sanitizeSponsorBlock(value: unknown): Persisted {
  const stored: Partial<Record<keyof Persisted, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  const enabled = stored.enabled === true
  // Skipping that is on was chosen, whatever `offered` says.
  return {
    enabled,
    offered: enabled || stored.offered === true,
    offerShown: stored.offerShown === true,
  }
}

export interface SponsorBlockStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the SponsorBlock store, persisted to Web Storage (one per app; tests make their own). */
export function createSponsorBlockStore({ storage }: SponsorBlockStoreOptions = {}) {
  return create<SponsorBlockState>()(
    persist(
      (set) => ({
        enabled: false,
        offered: false,
        offerShown: false,
        setEnabled: (enabled) => set({ enabled, offered: true }),
        dismissOffer: () => set({ offered: true }),
        markOfferShown: () => set({ offerShown: true }),
      }),
      {
        name: SPONSORBLOCK_STORAGE_KEY,
        version: SPONSORBLOCK_VERSION,
        storage: createSafeStorage<Persisted>(storage),
        partialize: ({ enabled, offered, offerShown }) => ({ enabled, offered, offerShown }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeSponsorBlock(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeSponsorBlock(persisted) }),
      },
    ),
  )
}

export type SponsorBlockStore = ReturnType<typeof createSponsorBlockStore>

export const useSponsorBlockStore: SponsorBlockStore = createSponsorBlockStore()

/**
 * Re-reads the setting when another tab changes it, so two open tabs agree on whether to skip.
 * Returns the unsubscribe function.
 */
export function syncSponsorBlockAcrossTabs(
  store: SponsorBlockStore = useSponsorBlockStore,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SPONSORBLOCK_STORAGE_KEY || event.key === null) {
      void store.persist.rehydrate()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

/**
 * sessionStorage key: set in the session that first shows the offer, which may show it again
 * (after a reload, say) until the user answers. Other sessions, new tabs included, don't.
 */
export const OFFER_SESSION_KEY = 'fxm.sponsorblock.offer-session'

/** Where sessionStorage can't keep the mark (blocked, full), the page's lifetime is the session. */
let offerSessionInMemory = false

/** Whether this session is the one that first showed the offer. */
export function isOfferSession(): boolean {
  if (offerSessionInMemory) return true
  try {
    return globalThis.sessionStorage.getItem(OFFER_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/** Makes this session the one that shows the offer. */
export function startOfferSession(): void {
  try {
    globalThis.sessionStorage.setItem(OFFER_SESSION_KEY, '1')
  } catch {
    offerSessionInMemory = true
  }
}
