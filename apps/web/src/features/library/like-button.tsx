import type { Track } from '@fxm/core'
import { Heart } from 'lucide-react'
import { IconButton, type IconButtonSize } from '../../components/ui/icon-button'
import { useTrackLike } from './use-track-like'

/**
 * The like button of the player, backed by the library. The player bar loads it lazily, so
 * the library database is not part of the shell's first download.
 */
export function LibraryLikeButton({ track, size }: { track: Track; size: IconButtonSize }) {
  const { liked, toggle } = useTrackLike(track)
  return (
    <IconButton
      label="Like"
      icon={<Heart fill={liked ? 'currentColor' : 'none'} />}
      size={size}
      pressed={liked}
      onClick={toggle}
    />
  )
}
