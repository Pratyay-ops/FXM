import type { Track } from '@fxm/core'
import { useCallback } from 'react'
import { useIsLiked } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import { failureText } from './failure'
import { showStatus } from './status'

/**
 * Whether `track` is liked, and a toggle that likes it (to the top of Liked songs) or removes
 * the like. Every like button shows the same state, because it is read live from the library.
 * A like that can't be saved says so in the toast, like every other library action.
 */
export function useTrackLike(track: Track): { liked: boolean; toggle: () => void } {
  const liked = useIsLiked(track.id)
  const toggle = useCallback(() => {
    getLibrary()
      .toggleLike(track)
      .catch((error: unknown) => showStatus(failureText(error)))
  }, [track])
  return { liked, toggle }
}
