import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Artwork } from '../../components/ui/artwork'
import { cn } from '../../lib/cn'
import { useShownImage } from '../search/sources-context'

const RADII = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl' } as const

export interface CoverArtProps {
  /**
   * The image, usually `artworkUrl(artwork, 2 × the displayed width)`. A string, so memoized
   * rows can compare it. The placeholder shows when there is none.
   */
  src?: string | undefined
  /** Seed of the placeholder's colors: the same ID always gets the same colors. */
  seed: string
  icon?: LucideIcon | undefined
  shape?: 'square' | 'circle'
  rounded?: keyof typeof RADII
  className?: string
}

/**
 * Cover art or a photo from the source, decorative (the title is next to it). Without one,
 * when it fails to load, or when the app may not load it (a host its policy doesn't allow, or
 * Spotify's while Spotify is switched off: `useShownImage`), the seeded placeholder shows.
 * Images load lazily and send no referrer.
 */
export function CoverArt({
  src,
  seed,
  icon,
  shape = 'square',
  rounded = 'md',
  className,
}: CoverArtProps) {
  const url = useShownImage(src)
  const [failed, setFailed] = useState<string | null>(null)
  if (url === undefined || failed === url) {
    return <Artwork seed={seed} icon={icon} shape={shape} rounded={rounded} className={className} />
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className={cn(
        'shrink-0 bg-elevated object-cover',
        shape === 'circle' ? 'rounded-full' : RADII[rounded],
        className,
      )}
    />
  )
}
