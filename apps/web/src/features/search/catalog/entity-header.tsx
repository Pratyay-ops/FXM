import type { Artwork as ArtworkImage, SourceId } from '@fxm/core'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageWash, seedWash } from '../../../components/media/collection-header'
import { TrackListSkeleton } from '../../../components/media/placeholders'
import { Skeleton } from '../../../components/ui/skeleton'
import { cn } from '../../../lib/cn'
import { ExplicitBadge, KindBadge, SourceBadge } from './badges'
import { CoverArt } from './cover-art'

const coverSize = 'size-44 shadow-xl sm:size-48 lg:size-56'

/**
 * The wash behind the header: the placeholder's color when there is no image, else a neutral
 * one (an image's colors aren't known, and reading them would need its bytes).
 */
function washFor(artwork: readonly ArtworkImage[], seed: string): string {
  return artwork.length === 0
    ? seedWash(seed)
    : 'color-mix(in oklab, var(--color-text) 14%, transparent)'
}

/**
 * The top of an album, artist or playlist page: cover art (or photo), the kind and source
 * badges, the name as the page's `<h1>`, and a byline.
 */
export function EntityHeader({
  kind,
  name,
  source,
  artwork,
  seed,
  shape = 'square',
  icon,
  explicit = false,
  children,
}: {
  /** What it is: `Album`, `Single`, `Artist`, `Playlist` … */
  kind: string
  name: string
  source: SourceId
  artwork: readonly ArtworkImage[]
  seed: string
  shape?: 'square' | 'circle'
  icon?: LucideIcon | undefined
  explicit?: boolean | undefined
  /** The byline: artists, year, size … */
  children?: ReactNode
}) {
  return (
    <>
      <PageWash color={washFor(artwork, seed)} />
      <div className="flex flex-col items-center gap-6 pt-2 text-center sm:flex-row sm:items-end sm:text-left">
        <CoverArt
          artwork={artwork}
          seed={seed}
          displayPx={224}
          shape={shape}
          rounded="lg"
          icon={icon}
          className={coverSize}
        />
        <div className="w-full min-w-0 flex-1 pb-1">
          <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-start">
            <KindBadge label={kind} />
            <SourceBadge source={source} />
            {explicit && <ExplicitBadge />}
          </div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-balance break-words sm:text-4xl lg:text-5xl">
            {name}
          </h1>
          {children && (
            <div className="mt-3 text-sm text-text-muted sm:mt-4 [&_a]:font-semibold [&_a]:text-text">
              {children}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** The page while it loads: the header, the actions and the list as placeholders. */
export function EntityPageSkeleton({
  label,
  shape = 'square',
}: {
  /** What loads, for screen readers, e.g. "Loading album". */
  label: string
  shape?: 'square' | 'circle'
}) {
  return (
    <div aria-busy="true" className="space-y-8">
      <div className="flex flex-col items-center gap-6 pt-2 sm:flex-row sm:items-end">
        <Skeleton
          className={cn(coverSize, 'shrink-0', shape === 'circle' ? 'rounded-full' : 'rounded-lg')}
        />
        <div className="w-full min-w-0 flex-1 pb-1">
          <Skeleton className="mx-auto h-5 w-28 rounded-sm sm:mx-0" />
          <h1 className="mt-3">
            <span className="sr-only">{label}</span>
            <Skeleton className="mx-auto h-9 w-3/4 max-w-md rounded-lg sm:mx-0 sm:h-12" />
          </h1>
          <Skeleton className="mx-auto mt-4 h-4 w-1/2 max-w-xs rounded-full sm:mx-0" />
        </div>
      </div>
      <div className="flex items-center justify-center gap-3 sm:justify-start">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="size-11 rounded-full" />
      </div>
      <TrackListSkeleton count={8} />
    </div>
  )
}
