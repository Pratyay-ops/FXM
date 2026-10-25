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
import { Fragment } from 'react'
import { Link } from 'react-router'
import { cn } from '../../../lib/cn'
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
      onSelect: () => {
        downloads.download(tracks)
        showFeedback(tracks.length === 1 ? `Downloading ${title}` : `Downloading ${count}`)
      },
    })
  }
  return items
}

/** The menu of one track: the list actions, its album and artist, and the equalizer. */
function useTrackMenu(track: Track): MenuAction[] {
  const items = useTracksMenu([track], track.title)
  const { equalizer } = useMediaActions()
  const { capabilities } = useSourcesSnapshot()
  const links: MenuAction[] = []
  if (track.album?.id) {
    links.push({ key: 'album', label: 'Go to album', icon: Disc3, to: albumPath(track.album.id) })
  }
  const artist = track.artists.find((candidate) => candidate.id !== undefined)
  if (artist?.id) {
    links.push({ key: 'artist', label: 'Go to artist', icon: MicVocal, to: artistPath(artist.id) })
  }
  const effects: MenuAction[] =
    equalizer && itemFeatures(capabilities, track.source).equalizer
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

/** The track's artists, each linked to their page when the source links one. */
export function ArtistLinks({
  artists,
  className,
}: {
  artists: Track['artists']
  className?: string
}) {
  return (
    <span className={cn('truncate', className)}>
      {artists.map((artist, index) => (
        <Fragment key={`${artist.id ?? ''}:${artist.name}`}>
          {index > 0 && ', '}
          {artist.id ? (
            <Link
              to={artistPath(artist.id)}
              className="relative z-10 hover:text-text hover:underline"
            >
              {artist.name}
            </Link>
          ) : (
            artist.name
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
}

/**
 * One track: artwork (or its number), title, artists, kind and source badges, duration and a
 * menu. The title is a button that plays the track and stretches over the whole row, while the
 * links and the menu stay clickable on top of it. Phones put the badges on a third line.
 */
export function TrackRow({ track, number, showAlbum = false, onPlay }: TrackRowProps) {
  const menu = useTrackMenu(track)
  const artists = artistNames(track.artists)
  const duration = formatDuration(track.durationMs)
  const video = isVideoKind(track.kind)
  return (
    <div className="group relative flex min-h-16 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-text/6 has-[button:focus-visible]:bg-text/6 sm:gap-4">
      {number === undefined ? (
        <span className="relative shrink-0">
          <CoverArt
            artwork={track.artwork}
            seed={track.id}
            displayPx={video ? 112 : 48}
            rounded="sm"
            className={video ? 'aspect-video w-24 sm:w-28' : 'size-12'}
          />
          {onPlay && (
            <span
              aria-hidden="true"
              className="absolute inset-0 hidden place-items-center rounded-sm bg-black/45 text-white group-hover:grid"
            >
              <Play className="size-5" fill="currentColor" strokeWidth={0} />
            </span>
          )}
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
            aria-label={artists ? `Play ${track.title} by ${artists}` : `Play ${track.title}`}
            className="block max-w-full truncate text-left font-semibold outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus focus-visible:after:outline-solid"
          >
            {track.title}
          </button>
        ) : (
          <p className="truncate font-semibold">{track.title}</p>
        )}
        {/* Phones: artists, then the badges on their own line; wider: badges first. */}
        <div className="mt-0.5 flex min-w-0 flex-col gap-1 text-sm text-text-muted sm:flex-row sm:items-center sm:gap-2">
          <span className="flex min-w-0 items-center">
            <ArtistLinks artists={track.artists} />
            {showAlbum && track.album && (
              <span className="hidden min-w-0 truncate md:inline">
                <span aria-hidden="true">&nbsp;·&nbsp;</span>
                {track.album.id ? (
                  <Link
                    to={albumPath(track.album.id)}
                    className="relative z-10 hover:text-text hover:underline"
                  >
                    {track.album.name}
                  </Link>
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
            className="sm:order-first"
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

/** A list of tracks; see {@link TrackRow}. */
export function TrackList({
  tracks,
  label,
  numbered = false,
  showAlbum = false,
  onPlay,
  className,
}: TrackListProps) {
  const keys = listKeys(tracks)
  return (
    <ul aria-label={label} className={cn('space-y-0.5', className)}>
      {tracks.map((track, index) => (
        <li key={keys[index]}>
          <TrackRow
            track={track}
            number={numbered ? index + 1 : undefined}
            showAlbum={showAlbum}
            onPlay={onPlay ? () => onPlay(index) : undefined}
          />
        </li>
      ))}
    </ul>
  )
}
