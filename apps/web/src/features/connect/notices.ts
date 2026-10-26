/**
 * Which notice the shell shows about the connection, and which ones the user dismissed:
 *
 * - `outdated`: FXM Connect answered with a version older than this app needs (upgrade prompt);
 * - `missing`: FXM Connect worked in this browser before and doesn't answer now ("was present,
 *   now missing"): turned off, removed or blocked by the browser;
 * - `intro`: the first visit without FXM Connect, which says what works here and how to get more.
 *
 * A dismissed notice stays away for the same state and version, so updating FXM Connect to a
 * version that is still too old, say, brings the prompt back.
 *
 * @module
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'
import { type ConnectionState, forgetConnect } from './connection'
import { isDetecting } from './explain'
import { tierOf } from './tiers'

/** The kinds of notice. */
export type NoticeKind = 'outdated' | 'missing' | 'intro'

/** A notice to show, with the ID its dismissal is remembered under. */
export interface Notice {
  readonly kind: NoticeKind
  readonly id: string
}

/** The notice for a connection state, if any. */
export function noticeFor(
  state: Pick<ConnectionState, 'phase' | 'platform' | 'capabilities' | 'connect' | 'lite'>,
): Notice | undefined {
  if (isDetecting(state) || state.phase === 'failed' || state.platform !== 'web') return undefined
  const { connect } = state
  if (connect?.state === 'outdated') {
    return { kind: 'outdated', id: `outdated:${connect.version ?? ''}` }
  }
  if (connect?.state === 'missing') {
    return { kind: 'missing', id: `missing:${connect.lastSeenVersion ?? ''}` }
  }
  if (connect?.state === 'absent' && tierOf(state.capabilities) !== 'full') {
    // Wait for Lite's verdict, so the first notice says the right thing.
    return state.lite === 'checking' ? undefined : { kind: 'intro', id: 'intro' }
  }
  return undefined
}

/** localStorage key of the dismissed notices. */
export const NOTICES_STORAGE_KEY = 'fxm.connect.notices.v1'

/** How many dismissals are kept: plenty for the few states and versions there are. */
const MAX_DISMISSED = 20

interface NoticeState {
  /** The IDs of the dismissed notices, oldest first. */
  readonly dismissed: readonly string[]
  /** Dismisses a notice. */
  dismiss(id: string): void
}

function sanitizeDismissed(value: unknown): string[] {
  const dismissed = (value as { dismissed?: unknown } | null)?.dismissed
  return Array.isArray(dismissed)
    ? dismissed.filter((id): id is string => typeof id === 'string').slice(-MAX_DISMISSED)
    : []
}

/** The dismissed notices, persisted in `localStorage`. */
export const useNotices = create<NoticeState>()(
  persist(
    (set) => ({
      dismissed: [],
      dismiss: (id) =>
        set((state) =>
          state.dismissed.includes(id)
            ? state
            : { dismissed: [...state.dismissed, id].slice(-MAX_DISMISSED) },
        ),
    }),
    {
      name: NOTICES_STORAGE_KEY,
      version: 1,
      storage: createSafeStorage<{ dismissed: readonly string[] }>(),
      partialize: ({ dismissed }) => ({ dismissed }),
      merge: (persisted, current) => ({ ...current, dismissed: sanitizeDismissed(persisted) }),
    },
  ),
)

/**
 * The user removed FXM Connect on purpose: FXM forgets it was here ("missing" becomes "absent"),
 * and doesn't follow up with the first-visit invitation to add it.
 */
export function removedOnPurpose(): void {
  useNotices.getState().dismiss('intro')
  forgetConnect()
}
