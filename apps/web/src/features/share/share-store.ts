import type { EntityId } from '@fxm/core'
import { create } from 'zustand'
import { type EmbedTarget, embedTargetOf } from '../../embed/target'
import type { PreviewInfo } from '../../embed/view'
import { isWired } from '../../embed/wired'
import { RELEASED } from '../connect/config'

/**
 * Whether the app offers to share a player for `target`. A production build offers it only once
 * the embed is released (`RELEASED.embed`, with the landing page's `AVAILABLE.embed`), and then
 * only for sources the embed can play (`WIRED_SOURCES`), so nobody publishes a player that can
 * only say it can't play; development builds and the tests always do, so the dialog can be tried.
 */
export function canShare(
  target: EmbedTarget,
  env: { readonly PROD: boolean } = import.meta.env,
  released: boolean = RELEASED.embed,
): boolean {
  return !env.PROD || (released && isWired(target))
}

/** What the share dialog shares: the entity, and what the app knows about it for the preview. */
export interface ShareRequest {
  /** The track, album or playlist. */
  readonly target: EmbedTarget
  /** Its title, artists, artwork and tracks, as far as the app has them. */
  readonly info: PreviewInfo
}

interface ShareState {
  /** What the dialog shares while it is open. */
  readonly request: ShareRequest | undefined
  open(request: ShareRequest): void
  close(): void
}

/** The share dialog's state: one dialog for the whole app, opened from anywhere. */
export const useShareStore = create<ShareState>()((set) => ({
  request: undefined,
  open: (request) => set({ request }),
  close: () => set({ request: undefined }),
}))

/**
 * Opens the share dialog for an entity, e.g. from a menu. Returns `false`, and opens nothing,
 * when no embed can show it (an artist, a Spotify track, a local file) or the app doesn't offer
 * to share it yet ({@link canShare}).
 */
export function openShareDialog(id: EntityId, info: PreviewInfo): boolean {
  const target = embedTargetOf(id)
  if (target === undefined || !canShare(target)) return false
  useShareStore.getState().open({ target, info })
  return true
}
