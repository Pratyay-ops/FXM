import type { Artwork as ArtworkImage } from '@fxm/core'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Artwork } from '../../../components/ui/artwork'
import { cn } from '../../../lib/cn'

const RADII = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl' } as const

/**
 * The image to show at `displayPx` CSS pixels: the smallest one at least twice that wide (for
 * high-density screens), else the largest. Images without a width count as large.
 */
export function pickArtwork(
  artwork: readonly ArtworkImage[],
  displayPx: number,
): ArtworkImage | undefined {
  const target = displayPx * 2
  const sized = [...artwork].sort(
    (a, b) => (a.width ?? Number.POSITIVE_INFINITY) - (b.width ?? Number.POSITIVE_INFINITY),
  )
  return sized.find((image) => (image.width ?? Number.POSITIVE_INFINITY) >= target) ?? sized.at(-1)
}

export interface CoverArtProps {
  /** The source's images, in any order. */
  artwork: readonly ArtworkImage[]
  /** Seed of the placeholder shown without an image, or when it fails to load. */
  seed: string
  /** How wide the image is shown, in CSS pixels, to pick a size. */
  displayPx: number
  shape?: 'square' | 'circle' | undefined
  rounded?: keyof typeof RADII | undefined
  /** Icon of the placeholder. */
  icon?: LucideIcon | undefined
  /** Size and layout classes (not border radius: use `rounded`). */
  className?: string | undefined
}

/**
 * Cover art or an artist photo from the source, decorative (the name is always next to it),
 * with the seeded placeholder when there is no image or it fails to load. Images load lazily
 * and send no Referer.
 */
export function CoverArt({
  artwork,
  seed,
  displayPx,
  shape = 'square',
  rounded = 'md',
  icon,
  className,
}: CoverArtProps) {
  const image = pickArtwork(artwork, displayPx)
  const [failedUrl, setFailedUrl] = useState<string>()
  if (image === undefined || image.url === failedUrl) {
    return <Artwork seed={seed} shape={shape} rounded={rounded} icon={icon} className={className} />
  }
  return (
    <img
      src={image.url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(image.url)}
      className={cn(
        'shrink-0 bg-skeleton object-cover',
        shape === 'circle' ? 'rounded-full' : RADII[rounded],
        className,
      )}
    />
  )
}
