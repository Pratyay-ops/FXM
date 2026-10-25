import type { LucideIcon } from 'lucide-react'
import { seedHue } from '../../lib/seed'
import { Artwork } from '../ui/artwork'
import { Skeleton } from '../ui/skeleton'

/**
 * A soft color wash behind the top of a page (and the transparent top bar above it).
 * It is positioned against <main> (see AppLayout), so it spans the whole content
 * column, also on screens wider than the page's max-w-page.
 */
export function PageWash({ color }: { color: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-[26rem]"
      style={{ backgroundImage: `linear-gradient(to bottom, ${color}, transparent)` }}
    />
  )
}

/** The wash color that matches a seed's placeholder artwork. */
export function seedWash(seed: string): string {
  return `oklch(0.55 0.14 ${seedHue(seed)} / 0.35)`
}

export interface CollectionHeaderProps {
  kind: 'Album' | 'Artist' | 'Playlist'
  /** Route id; shown until real metadata arrives. */
  id: string
  /** Seed for the placeholder artwork color. */
  seed: string
  shape?: 'square' | 'circle'
  icon?: LucideIcon | undefined
}

/**
 * Header skeleton for album, artist and playlist pages: artwork, kind, a title
 * placeholder and the id. Real titles and metadata replace it in stage 2.4.
 */
export function CollectionHeader({
  kind,
  id,
  seed,
  shape = 'square',
  icon,
}: CollectionHeaderProps) {
  return (
    <div className="flex flex-col items-center gap-6 pt-2 text-center sm:flex-row sm:items-end sm:text-left">
      <Artwork
        seed={seed}
        shape={shape}
        icon={icon}
        rounded="lg"
        className="size-44 shadow-xl sm:size-48 lg:size-56"
      />
      <div className="w-full min-w-0 flex-1 pb-1">
        <p className="text-xs font-bold tracking-[0.14em] text-text-muted uppercase">{kind}</p>
        <h1 className="mt-3">
          <span className="sr-only">
            {kind} {id}
          </span>
          <Skeleton className="mx-auto h-9 w-3/4 max-w-md rounded-lg sm:mx-0 sm:h-12" />
        </h1>
        <Skeleton className="mx-auto mt-4 h-4 w-1/2 max-w-xs rounded-full sm:mx-0" />
        <p className="mt-4 text-xs text-text-muted">
          <span className="font-semibold">ID</span>{' '}
          <code className="font-mono break-all text-text">{id}</code>
        </p>
      </div>
    </div>
  )
}
