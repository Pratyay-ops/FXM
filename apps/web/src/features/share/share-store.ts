import type { EntityId } from '@fxm/core'
import { create } from 'zustand'
import { type EmbedTarget, embedTargetOf } from '../../embed/target'
import type { PreviewInfo } from '../../embed/view'

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
 * when no embed can show it (an artist, a Spotify track, a local file).
 */
export function openShareDialog(id: EntityId, info: PreviewInfo): boolean {
  const target = embedTargetOf(id)
  if (target === undefined) return false
  useShareStore.getState().open({ target, info })
  return true
}
