import { cn } from '../../lib/cn'
import { placeholderKeys, Skeleton } from '../ui/skeleton'

/** Artwork plus two text lines: an album, playlist, mix or (round) artist card. */
export function CardSkeleton({ shape = 'square' }: { shape?: 'square' | 'circle' }) {
  const round = shape === 'circle'
  return (
    <div>
      <Skeleton className={cn('aspect-square w-full', round ? 'rounded-full' : 'rounded-md')} />
      <Skeleton className={cn('mt-3 h-3.5 rounded-full', round ? 'mx-auto w-3/5' : 'w-4/5')} />
      <Skeleton className={cn('mt-2 h-3 rounded-full', round ? 'mx-auto w-2/5' : 'w-1/2')} />
    </div>
  )
}

/** A horizontally scrolling row of cards that bleeds to the screen edge on phones. */
export function CardScroller({
  count = 8,
  shape = 'square',
}: {
  count?: number
  /** `mixed` alternates squares and circles, like a "recently played" row. */
  shape?: 'square' | 'circle' | 'mixed'
}) {
  return (
    <ul
      aria-hidden="true"
      className="-mx-gutter grid auto-cols-[9rem] grid-flow-col gap-4 overflow-x-auto px-gutter pb-2 scroll-px-gutter scrollbar-thin snap-x snap-mandatory sm:auto-cols-[10.5rem] lg:auto-cols-[11.5rem]"
    >
      {placeholderKeys(count, 'card').map((key, index) => (
        <li key={key} className="snap-start">
          <CardSkeleton
            shape={shape === 'mixed' ? (index % 3 === 1 ? 'circle' : 'square') : shape}
          />
        </li>
      ))}
    </ul>
  )
}

/** A responsive grid of cards (search results, artist discographies). */
export function CardGrid({
  count = 10,
  shape = 'square',
}: {
  count?: number
  shape?: 'square' | 'circle'
}) {
  return (
    <ul
      aria-hidden="true"
      className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
    >
      {placeholderKeys(count, 'grid').map((key) => (
        <li key={key}>
          <CardSkeleton shape={shape} />
        </li>
      ))}
    </ul>
  )
}

/** A compact song row: artwork, title and artist. */
export function SongRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Skeleton className="size-12 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-3/4 rounded-full" />
        <Skeleton className="h-3 w-1/2 rounded-full" />
      </div>
    </div>
  )
}

/** A single column of song rows (search results). */
export function SongList({ count = 8 }: { count?: number }) {
  return (
    <ul aria-hidden="true" className="divide-y divide-border/60">
      {placeholderKeys(count, 'song-row').map((key) => (
        <li key={key} className="flex items-center gap-4 py-1">
          <div className="min-w-0 flex-1">
            <SongRowSkeleton />
          </div>
          <Skeleton className="h-3 w-10 shrink-0 rounded-full" />
        </li>
      ))}
    </ul>
  )
}

/** Song rows in a grid that grows columns with the screen (Home's quick picks). */
export function SongGrid({ count = 9 }: { count?: number }) {
  return (
    <ul aria-hidden="true" className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
      {placeholderKeys(count, 'song').map((key, index) => (
        // One column on phones: four rows are enough there.
        <li key={key} className={cn(index >= 4 && 'max-sm:hidden')}>
          <SongRowSkeleton />
        </li>
      ))}
    </ul>
  )
}

/** A numbered track list (albums, playlists, artist top songs). */
export function TrackListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <ol aria-hidden="true" className="divide-y divide-border/60">
      {placeholderKeys(count, 'track').map((key, index) => (
        <li key={key} className="flex items-center gap-4 py-3">
          <span className="w-6 shrink-0 text-right text-sm tabular-nums text-text-muted">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 max-w-80 rounded-full" />
            <Skeleton className="h-3 w-1/3 max-w-48 rounded-full" />
          </div>
          <Skeleton className="h-3 w-10 shrink-0 rounded-full" />
        </li>
      ))}
    </ol>
  )
}

/** 16:9 video thumbnails with a title (Music + Video search results). */
export function VideoGrid({ count = 6 }: { count?: number }) {
  return (
    <ul aria-hidden="true" className="grid gap-x-4 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
      {placeholderKeys(count, 'video').map((key) => (
        <li key={key}>
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="mt-3 h-3.5 w-4/5 rounded-full" />
          <Skeleton className="mt-2 h-3 w-2/5 rounded-full" />
        </li>
      ))}
    </ul>
  )
}
