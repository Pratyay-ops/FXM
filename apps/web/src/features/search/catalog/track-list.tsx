import { isVideoKind, type Track } from '@fxm/core'
import {
  Disc3,
  Download,
  ListEnd,
  ListPlus,
  ListStart,
  MicVocal,
  Play,
  SlidersVertical,
} from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { Link } from 'react-router'
import {
  NowPlayingBars,
  NowPlayingOverlay,
  type NowPlayingStatus,
  nowPlayingLabel,
  nowPlayingText,
} from '../../../components/ui/now-playing-marker'
import { cn } from '../../../lib/cn'
import { useConnection } from '../../connect/connection'
import {
  type DownloadMenuItem,
  type DownloadMenuRow,
  useDownloadMenuItem,
  useSaveMenuItem,
} from '../../downloads/menu'
import type { MenuItem } from '../../library/ui/menu'
import { type RowCopy, rowCopies, useNowPlayingStatus } from '../../now-playing/current-track'
import { useMediaActions } from '../actions'
import { showFeedback } from '../feedback'
import { itemFeatures } from '../sources'
import { useSourcesSnapshot } from '../sources-context'
import { ActionMenu, type MenuAction } from './action-menu'
import { openAddToPlaylist } from './add-to-playlist'
import { ItemBadges } from './badges'
import { CoverArt } from './cover-art'
import { artistNames, countLabel, formatDuration, listKeys, trackKindLabel } from './format'
import { albumPath, artistPath } from './links'

/**
 * The menu entries for tracks: play next, add to queue, add to playlist, and, where the tier
 * allows it, download and the equalizer. Each appears only when its stage is wired in (see
 * actions.tsx). `title` names the tracks in messages, e.g. an album's name.
 */
export function useTracksMenu(tracks: readonly Track[], title: string): MenuAction[] {
  const actions = useMediaActions()
  const { capabilities } = useSourcesSnapshot()
  if (tracks.length === 0) return []
  const count = countLabel(tracks.length, 'song')
  // A list from one source shares its features; a mixed list allows what every item allows.
  const features = tracks.map((track) => itemFeatures(capabilities, track.source))
  const canDownload = features.every((feature) => feature.download)
  const items: MenuAction[] = []
  const { playback, library, downloads } = actions
  if (playback) {
    items.push(
      {
        key: 'play-next',
        label: 'Play next',
        icon: ListStart,
        onSelect: () => {
          playback.playNext(tracks)
          showFeedback(tracks.length === 1 ? `${title} plays next` : `${count} play next`)
        },
      },
      {
        key: 'add-to-queue',
        label: 'Add to queue',
        icon: ListEnd,
        onSelect: () => {
          playback.addToQueue(tracks)
          showFeedback(
            tracks.length === 1 ? `Added ${title} to the queue` : `Added ${count} to the queue`,
          )
        },
      },
    )
  }
  if (library) {
    items.push({
      key: 'add-to-playlist',
      label: 'Add to playlist…',
      icon: ListPlus,
      onSelect: () => openAddToPlaylist({ tracks, title }),
    })
  }
  if (downloads && canDownload) {
    items.push({
      key: 'download',
      label: 'Download',
      icon: Download,
      // The Download dialog, or an offline copy that says what became of it (Settings).
      onSelect: () => downloads.download(tracks, tracks.length === 1 ? undefined : title),
    })
  }
  return items
}

/** The "Save to device…" entries of a list's rows (`useSaveMenuItem`), read once per list. */
export type SaveMenuItem = (row: DownloadMenuRow) => MenuItem | undefined

/** A library menu entry as a catalog menu's, when it is an action. */
function asAction(entry: MenuItem | undefined): MenuAction | undefined {
  if (entry === undefined || (entry.kind !== undefined && entry.kind !== 'action')) return undefined
  return {
    key: entry.id,
    label: entry.label,
    icon: entry.icon ?? Download,
    onSelect: entry.onSelect,
  }
}

/**
 * The menu of one track: the list actions, its album and artist, and the equalizer. With
 * `downloadEntry` (the list's `useDownloadMenuItem`, stage 4.1), a track whose download exists
 * already gets "Cancel download" or "Remove download" in place of "Download", as in the
 * library's menus, once downloads are wired in (2.4's `downloads`); with `saveEntry` (the
 * list's `useSaveMenuItem`), a downloaded track also gets "Save to device…".
 */
function useTrackMenu(
  track: Track,
  downloadEntry?: DownloadMenuItem,
  saveEntry?: SaveMenuItem,
): MenuAction[] {
  const listed = useTracksMenu([track], track.title)
  const { equalizer, downloads } = useMediaActions()
  const { capabilities } = useSourcesSnapshot()
  const platform = useConnection((state) => state.platform)
  const entry = asAction(
    downloads === undefined ? undefined : downloadEntry?.({ id: track.id, track }),
  )
  const existing = entry?.key === 'download' ? undefined : entry
  const save = asAction(downloads === undefined ? undefined : saveEntry?.({ id: track.id, track }))
  const items: MenuAction[] =
    existing === undefined
      ? listed
      : [...listed.filter((item) => item.key !== 'download'), existing]
  if (save !== undefined) items.push(save)
  const links: MenuAction[] = []
  if (track.album?.id) {
    links.push({ key: 'album', label: 'Go to album', icon: Disc3, to: albumPath(track.album.id) })
  }
  const artist = track.artists.find((candidate) => candidate.id !== undefined)
  if (artist?.id) {
    links.push({ key: 'artist', label: 'Go to artist', icon: MicVocal, to: artistPath(artist.id) })
  }
  const effects: MenuAction[] =
    equalizer && itemFeatures(capabilities, track.source, platform).equalizer
      ? [
          {
            key: 'equalizer',
            label: 'Equalizer',
            icon: SlidersVertical,
            onSelect: () => equalizer.open(track),
          },
        ]
      : []
  return [...items, ...links, ...effects]
}

/**
 * A link in a line of text. `relative z-10` lifts it above a row's stretched play button; the
 * focus ring is drawn inside it, because a truncating parent (`overflow: hidden`) cuts off
 * anything drawn outside.
 */
const textLinkClasses =
  'relative z-10 rounded-xs hover:text-text hover:underline focus-visible:-outline-offset-2'

/**
 * An artist or album name in a track row, linked to its page only on wide screens with a mouse
 * or trackpad. The names are small targets close together (WCAG 2.5.8, and the app's 44 px rule
 * below 1024 px and on touch screens), so elsewhere they are plain text: a tap on them plays the
 * row like the rest of it, and the row's menu has "Go to artist" and "Go to album" instead.
 */
function RowLink({ to, children }: { to: string; children: string }) {
  return (
    <>
      <span className="lg:pointer-fine:hidden">{children}</span>
      <Link to={to} className={cn(textLinkClasses, 'hidden lg:pointer-fine:inline')}>
        {children}
      </Link>
    </>
  )
}

/**
 * The track's artists, each linked to their page when the source links one. `inRow` follows
 * the rules of a track row (see {@link RowLink}).
 */
export function ArtistLinks({
  artists,
  inRow = false,
  className,
}: {
  artists: Track['artists']
  inRow?: boolean
  className?: string
}) {
  return (
    <span className={cn('truncate', className)}>
      {artists.map((artist, index) => (
        <Fragment key={`${artist.id ?? ''}:${artist.name}`}>
          {index > 0 && ', '}
          {!artist.id ? (
            artist.name
          ) : inRow ? (
            <RowLink to={artistPath(artist.id)}>{artist.name}</RowLink>
          ) : (
            <Link to={artistPath(artist.id)} className={textLinkClasses}>
              {artist.name}
            </Link>
          )}
        </Fragment>
      ))}
    </span>
  )
}

export interface TrackRowProps {
  track: Track
  /** The number shown instead of artwork, e.g. the position on an album. */
  number?: number | undefined
  /** Show the album next to the artists. */
  showAlbum?: boolean | undefined
  /** Plays the track (in its list). Without it the row only shows the track. */
  onPlay?: (() => void) | undefined
  /**
   * The download entries of the row's list (`useDownloadMenuItem`), read once for the whole
   * list: the menu's entry then follows where the track's download stands.
   */
  downloadEntry?: DownloadMenuItem | undefined
  /** The list's "Save to device…" entries (`useSaveMenuItem`), for a downloaded track. */
  saveEntry?: SaveMenuItem | undefined
  /** Whether the track is the player's current one, and how it stands: the row is marked. */
  nowPlaying?: NowPlayingStatus | undefined
}

/**
 * One track: artwork (or its number), title, artists, kind and source badges, duration and a
 * menu. The title is a button that plays the track and stretches over the whole row, while the
 * links (on wide screens with a mouse) and the menu stay clickable on top of it. Phones put the
 * badges on a third line; wider screens put them after the names, so the names line up.
 *
 * The current track's row (`nowPlaying`) has the "now playing" marker in place of its number,
 * or over its artwork, and its title in the accent colour; its name says "Now playing",
 * "Paused" or "Couldn’t play".
 */
export function TrackRow({
  track,
  number,
  showAlbum = false,
  onPlay,
  downloadEntry,
  saveEntry,
  nowPlaying,
}: TrackRowProps) {
  const menu = useTrackMenu(track, downloadEntry, saveEntry)
  const artists = artistNames(track.artists)
  const duration = formatDuration(track.durationMs)
  const video = isVideoKind(track.kind)
  const titleColor = nowPlaying && 'text-accent forced-colors:text-[Highlight]'
  return (
    <div className="group relative flex min-h-16 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-text/6 has-[:focus-visible]:bg-text/6 sm:gap-4">
      {number === undefined ? (
        <span className="relative shrink-0">
          <CoverArt
            artwork={track.artwork}
            seed={track.id}
            displayPx={video ? 112 : 48}
            rounded="sm"
            className={video ? 'aspect-video w-24 sm:w-28' : 'size-12'}
          />
          {nowPlaying ? (
            <NowPlayingOverlay status={nowPlaying} />
          ) : (
            onPlay && (
              <span
                aria-hidden="true"
                className="absolute inset-0 hidden place-items-center rounded-sm bg-black/45 text-white group-hover:grid"
              >
                <Play className="size-5" fill="currentColor" strokeWidth={0} />
              </span>
            )
          )}
        </span>
      ) : nowPlaying ? (
        <span className="flex w-7 shrink-0 justify-end text-accent">
          {/* The bars take the number's place on screen, not for screen readers. */}
          <span className="sr-only">{number}</span>
          <NowPlayingBars status={nowPlaying} />
        </span>
      ) : (
        <span className="w-7 shrink-0 text-right text-sm tabular-nums text-text-muted">
          {number}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {onPlay ? (
          <button
            type="button"
            onClick={onPlay}
            aria-label={nowPlayingLabel(
              artists ? `Play ${track.title} by ${artists}` : `Play ${track.title}`,
              nowPlaying,
            )}
            className={cn(
              'block max-w-full truncate text-left font-semibold outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus focus-visible:after:outline-solid',
              titleColor,
            )}
          >
            {track.title}
          </button>
        ) : (
          <p className={cn('truncate font-semibold', titleColor)}>
            {track.title}
            {nowPlaying && <span className="sr-only">. {nowPlayingText(nowPlaying)}</span>}
          </p>
        )}
        {/* Phones: artists, then the badges on their own line; wider: names, then badges. */}
        <div className="mt-0.5 flex min-w-0 flex-col gap-1 text-sm text-text-muted sm:flex-row sm:items-center sm:gap-2">
          <span className="flex min-w-0 items-center">
            <ArtistLinks artists={track.artists} inRow />
            {showAlbum && track.album && (
              <span className="hidden min-w-0 truncate md:inline">
                <span aria-hidden="true">&nbsp;·&nbsp;</span>
                {track.album.id ? (
                  <RowLink to={albumPath(track.album.id)}>{track.album.name}</RowLink>
                ) : (
                  track.album.name
                )}
              </span>
            )}
          </span>
          <ItemBadges
            kind={trackKindLabel(track.kind)}
            source={track.source}
            explicit={track.explicit}
          />
        </div>
      </div>

      {duration && (
        <span className="hidden shrink-0 text-sm tabular-nums text-text-muted sm:block">
          {duration}
        </span>
      )}
      <ActionMenu
        label={`More options for ${track.title}`}
        items={menu}
        className="relative z-10"
      />
    </div>
  )
}

export interface TrackListProps {
  tracks: readonly Track[]
  /** Accessible name of the list, e.g. "Songs" or "Tracks". */
  label: string
  /** Number the rows (album and playlist pages) instead of showing artwork. */
  numbered?: boolean
  /** Show each track's album. */
  showAlbum?: boolean
  /** Plays the list from `index`. Without it the rows only show the tracks. */
  onPlay?: ((index: number) => void) | undefined
  className?: string
}

/**
 * One entry of a {@link TrackList}: the row, marked with `aria-current` while its track is the
 * player's current one. Each entry follows only whether that is so, so playback re-renders the
 * entries that gain or lose the marker, not the whole list.
 */
function TrackListItem({ rowCopy, ...row }: TrackRowProps & { rowCopy: RowCopy | undefined }) {
  const nowPlaying = useNowPlayingStatus(row.track.id, rowCopy)
  return (
    <li aria-current={nowPlaying === undefined ? undefined : 'true'}>
      <TrackRow {...row} nowPlaying={nowPlaying} />
    </li>
  )
}

/**
 * A list of tracks; see {@link TrackRow}. The row of the track the player is on is marked; of
 * a track the list shows more than once, the copy the queue plays.
 */
export function TrackList({
  tracks,
  label,
  numbered = false,
  showAlbum = false,
  onPlay,
  className,
}: TrackListProps) {
  const keys = listKeys(tracks)
  const copies = useMemo(() => rowCopies(tracks.map((track) => track.id)), [tracks])
  // One read of the downloads for the whole list, not one per row.
  const downloadEntry = useDownloadMenuItem()
  const saveEntry = useSaveMenuItem()
  return (
    <ul aria-label={label} className={cn('space-y-0.5', className)}>
      {tracks.map((track, index) => (
        <TrackListItem
          key={keys[index]}
          track={track}
          rowCopy={copies[index]}
          number={numbered ? index + 1 : undefined}
          showAlbum={showAlbum}
          onPlay={onPlay ? () => onPlay(index) : undefined}
          downloadEntry={downloadEntry}
          saveEntry={saveEntry}
        />
      ))}
    </ul>
  )
}
