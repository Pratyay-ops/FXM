/**
 * Home's shelves: the rows of songs and mixes, and a connected Spotify account's sections.
 * Every song is a button that plays its shelf from that song, when playback is wired in (see
 * `services.tsx`); otherwise the shelves only show.
 *
 * @module
 */

import {
  type DailyMix,
  type EntityId,
  type HomeTrack,
  parseId,
  type QueueContext,
  type ShelfItem,
  type Track,
} from '@fxm/core'
import { Disc3, ListMusic, MicVocal, Play } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { CoverArt } from '../library/cover-art'
import { artistNames, artworkUrl } from '../library/format'
import type { HomePlayback } from './services'

/** Plays `tracks` from `index`, or nothing when playback isn't wired in. */
export type PlayFrom = ((index: number) => void) | undefined

/** A function that plays `tracks` from an index, with `context`, if playback is wired in. */
export function playFrom(
  playback: HomePlayback | undefined,
  tracks: readonly Track[],
  context: QueueContext,
): PlayFrom {
  if (playback === undefined || tracks.length === 0) return undefined
  return (startIndex) => playback.play(tracks, { startIndex, context })
}

/** "Copper Sun by Aurora Lane". */
function trackLabel(track: Track): string {
  const artists = artistNames(track)
  return artists === '' ? track.title : `${track.title} by ${artists}`
}

/** A titled section of Home, with an optional action (such as Play) next to its title. */
export function ShelfSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string | undefined
  action?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** "Play" for a whole shelf, when playback is wired in. */
export function PlayAllButton({ play, label }: { play: PlayFrom; label: string }) {
  if (play === undefined) return null
  return (
    <button
      type="button"
      onClick={() => play(0)}
      aria-label={label}
      className={buttonClasses({ variant: 'secondary', className: 'h-9 px-4' })}
    >
      <Play aria-hidden="true" />
      Play
    </button>
  )
}

const SCROLLER =
  '-mx-gutter grid grid-flow-col gap-4 overflow-x-auto px-gutter pt-1 pb-2 scroll-px-gutter scrollbar-thin snap-x snap-mandatory'

/** A row of cards that scrolls sideways and bleeds to the screen edge on phones. */
function CardRow({ label, children }: { label: string; children: ReactNode[] }) {
  return (
    <ul
      aria-label={label}
      className={cn(SCROLLER, 'auto-cols-[9rem] sm:auto-cols-[10.5rem] lg:auto-cols-[11.5rem]')}
    >
      {children}
    </ul>
  )
}

/** The text under a card: a title and a muted line (or two). */
function CardText({
  title,
  subtitle,
  lines = 1,
}: {
  title: string
  subtitle: string
  lines?: 1 | 2
}) {
  return (
    <>
      <span className="mt-2.5 block truncate text-sm font-semibold">{title}</span>
      {subtitle && (
        <span
          className={cn(
            'mt-0.5 block text-sm text-text-muted',
            lines === 1 ? 'truncate' : 'line-clamp-2',
          )}
        >
          {subtitle}
        </span>
      )}
    </>
  )
}

/** The round play badge on a card's cover, shown on hover and focus. */
function PlayBadge() {
  return (
    <span
      aria-hidden="true"
      className="absolute right-2 bottom-2 grid size-10 place-items-center rounded-full bg-accent text-on-accent opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:hidden [&_svg]:size-5"
    >
      <Play fill="currentColor" />
    </span>
  )
}

/** One song as a card: its cover, title and artists. Plays when clicked, if it can. */
function TrackCard({ track, play }: { track: Track; play?: (() => void) | undefined }) {
  const cover = (
    <CoverArt
      src={artworkUrl(track.artwork, 360)}
      seed={track.id}
      className="aspect-square w-full shadow-md"
    />
  )
  const text = <CardText title={track.title} subtitle={artistNames(track)} />
  if (play === undefined) {
    return (
      <div>
        {cover}
        {text}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={play}
      aria-label={`Play ${trackLabel(track)}`}
      className="group block w-full rounded-md text-left"
    >
      <span className="relative block">
        {cover}
        <PlayBadge />
      </span>
      {text}
    </button>
  )
}

/** A shelf's songs as a sideways row of cards. */
export function TrackRow({
  label,
  items,
  play,
}: {
  label: string
  items: readonly HomeTrack[]
  play: PlayFrom
}) {
  return (
    <CardRow label={label}>
      {items.map((item, index) => (
        <li key={item.track.id} className="snap-start">
          <TrackCard track={item.track} play={play === undefined ? undefined : () => play(index)} />
        </li>
      ))}
    </CardRow>
  )
}

/** One song as a compact line: a small cover, the title and the artists. */
function TrackLine({ track, play }: { track: Track; play?: (() => void) | undefined }) {
  const body = (
    <>
      <CoverArt
        src={artworkUrl(track.artwork, 96)}
        seed={track.id}
        rounded="sm"
        className="size-12"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{track.title}</span>
        <span className="block truncate text-sm text-text-muted">{artistNames(track)}</span>
      </span>
    </>
  )
  const line = 'flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left'
  if (play === undefined) return <div className={line}>{body}</div>
  return (
    <button
      type="button"
      onClick={play}
      aria-label={`Play ${trackLabel(track)}`}
      className={cn(line, 'transition-colors hover:bg-text/6')}
    >
      {body}
    </button>
  )
}

/** Quick picks: columns of four lines that scroll sideways. */
export function QuickPicksGrid({ items, play }: { items: readonly HomeTrack[]; play: PlayFrom }) {
  return (
    <ul
      aria-label="Quick picks"
      className={cn(
        SCROLLER,
        // A sliver of the next column shows, so the grid reads as one that scrolls.
        'auto-cols-[min(85%,22rem)] grid-rows-4 gap-x-4 gap-y-1 sm:auto-cols-[45%] lg:auto-cols-[30%]',
      )}
    >
      {items.map((item, index) => (
        <li key={item.track.id} className="min-w-0 snap-start">
          <TrackLine track={item.track} play={play === undefined ? undefined : () => play(index)} />
        </li>
      ))}
    </ul>
  )
}

/** "Aurora Lane, Basalt and Cinder". */
export function mixArtists(mix: DailyMix): string {
  const names = mix.artists.slice(0, 3)
  if (names.length <= 1) return names[0] ?? ''
  if (mix.artists.length > 3) return `${names.join(', ')} and more`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Up to four covers of a mix's songs, for its collage. */
function mixCovers(mix: DailyMix): string[] {
  const covers: string[] = []
  for (const { track } of mix.tracks) {
    const url = artworkUrl(track.artwork, 180)
    if (url !== undefined && !covers.includes(url)) covers.push(url)
    if (covers.length === 4) break
  }
  return covers
}

/** A mix's cover: four of its songs' covers, else one, else a placeholder. */
function MixCover({ mix }: { mix: DailyMix }) {
  const covers = mixCovers(mix)
  if (covers.length < 4) {
    return (
      <CoverArt
        src={covers[0]}
        seed={mix.id}
        icon={ListMusic}
        className="aspect-square w-full shadow-md"
      />
    )
  }
  return (
    <span className="grid aspect-square w-full grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-md bg-elevated shadow-md">
      {covers.map((url) => (
        <CoverArt key={url} src={url} seed={url} rounded="sm" className="size-full" />
      ))}
    </span>
  )
}

/** The Daily Mixes as cards; a card opens its mix. */
export function MixRow({
  mixes,
  onOpen,
}: {
  mixes: readonly DailyMix[]
  onOpen: (mix: DailyMix) => void
}) {
  return (
    <CardRow label="Daily Mixes">
      {mixes.map((mix) => (
        <li key={mix.id} className="snap-start">
          <button
            type="button"
            onClick={() => onOpen(mix)}
            className="group block w-full rounded-md text-left"
            aria-haspopup="dialog"
          >
            <MixCover mix={mix} />
            <CardText title={mix.title} subtitle={mixArtists(mix)} lines={2} />
          </button>
        </li>
      ))}
    </CardRow>
  )
}

/** A mix's songs, as lines that play the mix from that song. */
export function MixTrackList({ mix, play }: { mix: DailyMix; play: PlayFrom }) {
  return (
    <ol aria-label={`Songs in ${mix.title}`} className="-mx-2 space-y-0.5">
      {mix.tracks.map((item, index) => (
        <li key={item.track.id}>
          <TrackLine track={item.track} play={play === undefined ? undefined : () => play(index)} />
        </li>
      ))}
    </ol>
  )
}

/**
 * The page of an album, artist or playlist: `/<kind>/<source>:<native ID>`, the form of stage
 * 2.4's pages.
 */
export function entityPath(id: EntityId<'album' | 'artist' | 'playlist'>): string {
  const { source, kind, nativeId } = parseId(id)
  return `/${kind}/${source}:${encodeURIComponent(nativeId)}`
}

/** One item of a service's section as a card. */
function SourceItemCard({ item, play }: { item: ShelfItem; play?: (() => void) | undefined }) {
  if (item.type === 'track') return <TrackCard track={item.track} play={play} />
  const entity =
    item.type === 'album'
      ? { id: item.album.id, name: item.album.name, artwork: item.album.artwork, icon: Disc3 }
      : item.type === 'artist'
        ? {
            id: item.artist.id,
            name: item.artist.name,
            artwork: item.artist.artwork,
            icon: MicVocal,
          }
        : {
            id: item.playlist.id,
            name: item.playlist.name,
            artwork: item.playlist.artwork,
            icon: ListMusic,
          }
  const subtitle =
    item.type === 'album'
      ? item.album.artists.map((artist) => artist.name).join(', ')
      : item.type === 'artist'
        ? 'Artist'
        : (item.playlist.owner?.name ?? 'Playlist')
  return (
    <Link to={entityPath(entity.id)} className="group block rounded-md">
      <CoverArt
        src={artworkUrl(entity.artwork, 360)}
        seed={entity.id}
        icon={entity.icon}
        shape={item.type === 'artist' ? 'circle' : 'square'}
        className="aspect-square w-full shadow-md"
      />
      <CardText title={entity.name} subtitle={subtitle} />
    </Link>
  )
}

/** A service's own section, e.g. one of a connected Spotify account's. */
export function SourceRow({
  label,
  items,
  play,
}: {
  label: string
  items: readonly ShelfItem[]
  /** Plays the section's songs from an index among them. */
  play: PlayFrom
}) {
  let trackIndex = 0
  return (
    <CardRow label={label}>
      {items.map((item) => {
        const index = item.type === 'track' ? trackIndex++ : -1
        const id =
          item.type === 'track'
            ? item.track.id
            : item.type === 'album'
              ? item.album.id
              : item.type === 'artist'
                ? item.artist.id
                : item.playlist.id
        return (
          <li key={id} className="snap-start">
            <SourceItemCard
              item={item}
              play={play === undefined || index < 0 ? undefined : () => play(index)}
            />
          </li>
        )
      })}
    </CardRow>
  )
}
