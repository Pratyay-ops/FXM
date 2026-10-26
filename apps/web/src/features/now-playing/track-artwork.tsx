import type { Artwork as ArtworkImage } from '@fxm/core'
import { type LucideIcon, Music } from 'lucide-react'
import { useState } from 'react'
import { Artwork } from '../../components/ui/artwork'
import { cn } from '../../lib/cn'
import { useShownImage } from '../search/sources-context'

const RADII = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl' } as const

/**
 * The image to show at `minWidth` pixels: the smallest one at least that wide, else the widest.
 * Images without a width count as narrow, unless none has one: then the last, which sources
 * list largest last.
 */
export function pickArtwork(
  images: readonly ArtworkImage[],
  minWidth: number,
): ArtworkImage | undefined {
  const sized = images.filter((image) => image.width !== undefined && image.width > 0)
  if (sized.length === 0) return images.at(-1)
  const byWidth = [...sized].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return byWidth.find((image) => (image.width ?? 0) >= minWidth) ?? byWidth.at(-1)
}

export interface TrackArtworkProps {
  /** The track's artwork in the sizes its source offers. May be empty. */
  images: readonly ArtworkImage[]
  /** Placeholder seed (a track ID): shown while the image loads, and if it fails or is missing. */
  seed: string
  /** The size the artwork is shown at, in CSS pixels, to pick an image sharp enough. */
  size: number
  rounded?: keyof typeof RADII | undefined
  icon?: LucideIcon | undefined
  /** Load the image only when it scrolls near the viewport (long lists). */
  lazy?: boolean | undefined
  /** Size, shadow and layout classes (not border radius: use `rounded`). */
  className?: string | undefined
}

/**
 * A track's cover art over a placeholder gradient, which stays when there is no image, it fails
 * to load, or the app may not load it (a host its policy doesn't allow, or Spotify's while
 * Spotify is switched off: `useShownImage`). Decorative: the title next to it names the track.
 * The image is requested without a referrer.
 */
export function TrackArtwork({
  images,
  seed,
  size,
  rounded = 'md',
  icon = Music,
  lazy = false,
  className,
}: TrackArtworkProps) {
  const [failedUrl, setFailedUrl] = useState<string>()
  // Twice the size covers high-density screens without picking the largest image everywhere.
  const url = useShownImage(pickArtwork(images, size * 2)?.url)
  return (
    <span
      aria-hidden="true"
      className={cn('relative block shrink-0 overflow-hidden', RADII[rounded], className)}
    >
      <Artwork seed={seed} rounded={rounded} icon={icon} className="size-full" />
      {url !== undefined && url !== failedUrl && (
        <img
          src={url}
          alt=""
          loading={lazy ? 'lazy' : 'eager'}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedUrl(url)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  )
}
