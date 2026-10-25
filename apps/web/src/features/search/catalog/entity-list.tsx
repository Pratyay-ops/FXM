import type { Album, Artist, Artwork as ArtworkImage, Playlist, SourceId } from '@fxm/core'
import { ListMusic, type LucideIcon, MicVocal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '../../../lib/cn'
import { ItemBadges } from './badges'
import { CoverArt } from './cover-art'
import { albumTypeLabel, artistNames, countLabel, listKeys, releaseYear } from './format'
import { albumPath, artistPath, playlistPath } from './links'

interface EntityRowProps {
  to: string
  title: string
  kind: string
  source: SourceId
  explicit?: boolean | undefined
  subtitle?: string | undefined
  artwork: readonly ArtworkImage[]
  seed: string
  shape?: 'square' | 'circle'
  icon?: LucideIcon | undefined
}

/**
 * A row that opens an album, artist or playlist page: artwork, name, kind and source badges and
 * a short subtitle. The name is a link stretched over the whole row.
 */
function EntityRow({
  to,
  title,
  kind,
  source,
  explicit,
  subtitle,
  artwork,
  seed,
  shape = 'square',
  icon,
}: EntityRowProps) {
  return (
    <div className="relative flex min-h-16 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-text/6 has-[a:focus-visible]:bg-text/6 sm:gap-4">
      <CoverArt
        artwork={artwork}
        seed={seed}
        displayPx={48}
        shape={shape}
        rounded="sm"
        icon={icon}
        className="size-12"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          className="block max-w-full truncate font-semibold outline-none after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus focus-visible:after:outline-solid"
        >
          {title}
        </Link>
        {/* Phones: the subtitle, then the badges on their own line; wider: badges first. */}
        <div className="mt-0.5 flex min-w-0 flex-col gap-1 text-sm text-text-muted sm:flex-row sm:items-center sm:gap-2">
          {subtitle && <span className="truncate">{subtitle}</span>}
          <ItemBadges kind={kind} source={source} explicit={explicit} className="sm:order-first" />
        </div>
      </div>
    </div>
  )
}

function EntityList<T extends { readonly id: string }>({
  items,
  label,
  children,
}: {
  items: readonly T[]
  label: string
  children: (item: T) => ReactNode
}) {
  const keys = listKeys(items)
  return (
    <ul aria-label={label} className="space-y-0.5">
      {items.map((item, index) => (
        <li key={keys[index]}>{children(item)}</li>
      ))}
    </ul>
  )
}

/** The subtitle of an album: its artists and year. */
export function albumSubtitle(album: Album): string {
  return [artistNames(album.artists), releaseYear(album.releaseDate)].filter(Boolean).join(' · ')
}

/** Albums, each linking to its page. */
export function AlbumList({
  albums,
  label = 'Albums',
}: {
  albums: readonly Album[]
  label?: string
}) {
  return (
    <EntityList items={albums} label={label}>
      {(album) => (
        <EntityRow
          to={albumPath(album.id)}
          title={album.name}
          kind={albumTypeLabel(album.type)}
          source={album.source}
          explicit={album.explicit}
          subtitle={albumSubtitle(album)}
          artwork={album.artwork}
          seed={album.id}
        />
      )}
    </EntityList>
  )
}

/** Artists, each linking to their page. */
export function ArtistList({
  artists,
  label = 'Artists',
}: {
  artists: readonly Artist[]
  label?: string
}) {
  return (
    <EntityList items={artists} label={label}>
      {(artist) => (
        <EntityRow
          to={artistPath(artist.id)}
          title={artist.name}
          kind="Artist"
          source={artist.source}
          artwork={artist.artwork}
          seed={artist.id}
          shape="circle"
          icon={MicVocal}
        />
      )}
    </EntityList>
  )
}

/** The subtitle of a playlist: its owner and size. */
export function playlistSubtitle(playlist: Playlist): string {
  return [
    playlist.owner?.name,
    playlist.trackCount === undefined ? undefined : countLabel(playlist.trackCount, 'song'),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Playlists, each linking to its page. */
export function PlaylistList({
  playlists,
  label = 'Playlists',
}: {
  playlists: readonly Playlist[]
  label?: string
}) {
  return (
    <EntityList items={playlists} label={label}>
      {(playlist) => (
        <EntityRow
          to={playlistPath(playlist.id)}
          title={playlist.name}
          kind="Playlist"
          source={playlist.source}
          subtitle={playlistSubtitle(playlist)}
          artwork={playlist.artwork}
          seed={playlist.id}
          icon={ListMusic}
        />
      )}
    </EntityList>
  )
}

/** A card in a shelf: artwork, name and a subtitle, linking to the item's page. */
export function EntityCard({
  to,
  title,
  subtitle,
  artwork,
  seed,
  shape = 'square',
  icon,
}: {
  to: string
  title: string
  subtitle?: string | undefined
  artwork: readonly ArtworkImage[]
  seed: string
  shape?: 'square' | 'circle'
  icon?: LucideIcon | undefined
}) {
  const round = shape === 'circle'
  return (
    <Link to={to} className="group block rounded-lg p-2 transition-colors hover:bg-text/6">
      <CoverArt
        artwork={artwork}
        seed={seed}
        displayPx={176}
        shape={shape}
        icon={icon}
        className="aspect-square w-full shadow-md"
      />
      <span className={cn('mt-3 block truncate text-sm font-semibold', round && 'text-center')}>
        {title}
      </span>
      {subtitle && (
        <span
          className={cn('mt-0.5 block truncate text-xs text-text-muted', round && 'text-center')}
        >
          {subtitle}
        </span>
      )}
    </Link>
  )
}

/**
 * A horizontally scrolling row of cards that bleeds to the screen edge on phones (the real
 * counterpart of the shell's `CardScroller` placeholder).
 */
export function CardShelf<T extends { readonly id: string }>({
  items,
  label,
  children,
}: {
  items: readonly T[]
  label: string
  children: (item: T) => ReactNode
}) {
  const keys = listKeys(items)
  return (
    <ul
      aria-label={label}
      // pt-1 and pb-2: the scroll box clips, so leave room for the cards' focus rings.
      className="-mx-gutter grid auto-cols-[9.5rem] grid-flow-col gap-2 overflow-x-auto px-gutter pt-1 pb-2 scroll-px-gutter scrollbar-thin snap-x snap-mandatory sm:auto-cols-[11rem] lg:auto-cols-[12rem]"
    >
      {items.map((item, index) => (
        <li key={keys[index]} className="snap-start">
          {children(item)}
        </li>
      ))}
    </ul>
  )
}

/** An album card's subtitle: its type and year, e.g. `EP · 2019`. */
export function albumCardSubtitle(album: Album): string {
  return [albumTypeLabel(album.type), releaseYear(album.releaseDate)].filter(Boolean).join(' · ')
}
