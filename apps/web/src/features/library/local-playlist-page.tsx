import type { EntityId } from '@fxm/core'
import {
  ArrowDownToLine,
  Copy,
  Download,
  Ellipsis,
  Heart,
  LibraryBig,
  ListMusic,
  Pencil,
  Trash,
} from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { PageWash, seedWash } from '../../components/media/collection-header'
import { TrackListSkeleton } from '../../components/media/placeholders'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { ErrorState } from '../../components/ui/error-state'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { Skeleton } from '../../components/ui/skeleton'
import { usePlaylistView } from '../../db/hooks'
import type { PlaylistView } from '../../db/repo'
import type { PlaylistRecord } from '../../db/types'
import { downloadTracks } from '../downloads/actions'
import { useCanDownload } from '../downloads/hooks'
import { PlayPauseButton } from '../player/controls'
import { CoverArt } from './cover-art'
import { artworkUrl, countLabel, totalDuration } from './format'
import { playlistIcon } from './paths'
import { duplicatePlaylist, usePlaylistDialogs } from './playlist-dialogs'
import { sortTrackRows } from './sort'
import { TrackList, type TrackListKind } from './track-list'
import { Menu, type MenuItem } from './ui/menu'
import { useTrackView } from './view-store'

/** The kind of track list a playlist record is. */
export function trackListKind(playlist: Pick<PlaylistRecord, 'system'>): TrackListKind {
  if (playlist.system === 'liked') return 'liked'
  if (playlist.system === 'downloads') return 'downloads'
  return 'playlist'
}

/** What an empty playlist says, by kind. */
export function EmptyList({ kind }: { kind: TrackListKind }) {
  const frame = 'rounded-2xl border border-dashed border-border'
  if (kind === 'liked') {
    return (
      <EmptyState
        icon={Heart}
        title="Songs you like show up here"
        description="Tap the heart on any song to save it to Liked songs. You can put them in any order you like."
        headingLevel={3}
        className={frame}
      />
    )
  }
  if (kind === 'downloads') {
    return (
      <EmptyState
        icon={Download}
        title="No downloads yet"
        description="Songs you download play without a connection and show up here, in an order you choose. Use Download in the menu of a song, or Download all on a playlist."
        headingLevel={3}
        className={frame}
      />
    )
  }
  return (
    <EmptyState
      icon={ListMusic}
      title="This playlist is empty"
      description="Add songs with “Add to playlist” in the menu of any song, for example in Liked songs or Recently played."
      action={
        <Link to="/library?tab=liked" className={buttonClasses({ variant: 'secondary' })}>
          <Heart aria-hidden="true" />
          Go to Liked songs
        </Link>
      }
      headingLevel={3}
      className={frame}
    />
  )
}

function PlaylistHeader({ view }: { view: PlaylistView }) {
  const { playlist, rows } = view
  const duration = totalDuration(rows.map((row) => row.track?.durationMs))
  return (
    <div className="flex flex-col items-center gap-6 pt-2 text-center sm:flex-row sm:items-end sm:text-left">
      <CoverArt
        src={artworkUrl(playlist.artwork ?? rows[0]?.track?.artwork, 448)}
        seed={`playlist:${playlist.id}`}
        icon={playlistIcon(playlist)}
        rounded="lg"
        className="size-44 shadow-xl sm:size-48 lg:size-56"
      />
      <div className="w-full min-w-0 flex-1 pb-1">
        <p className="text-xs font-bold tracking-[0.14em] text-text-muted uppercase">Playlist</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight break-words sm:text-4xl lg:text-5xl">
          {playlist.name}
        </h1>
        {playlist.description && (
          <p className="mt-3 text-text-muted break-words">{playlist.description}</p>
        )}
        <p className="mt-3 text-sm text-text-muted">
          {countLabel(rows.length, 'song')}
          {duration && ` · ${duration}`}
        </p>
      </div>
    </div>
  )
}

/** The page of a playlist of this library, at `/playlist/local:playlist:…`. */
export function LocalPlaylistPage({ id }: { id: EntityId<'playlist'> }) {
  const live = usePlaylistView(id)
  const navigate = useNavigate()
  const dialogs = usePlaylistDialogs({ onDeleted: () => navigate('/library') })
  const canDownload = useCanDownload()
  // The order the list shows (a sort view, or the custom order), which Play follows too.
  const view = useTrackView(id)

  if (live.status === 'loading') {
    return (
      <div role="status" className="space-y-8 pt-4">
        <span className="sr-only">Loading…</span>
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-end">
          <Skeleton className="size-44 rounded-lg sm:size-48 lg:size-56" />
          <Skeleton className="h-12 w-64 max-w-full rounded-lg" />
        </div>
        <TrackListSkeleton count={8} />
      </div>
    )
  }
  if (live.status === 'error') {
    return (
      <ErrorState
        title="This playlist can't be opened"
        message="The browser didn't let FXM read your library. Private windows and turned-off site data can block it."
      />
    )
  }
  if (live.data === undefined) {
    return (
      <ErrorState
        title="Playlist not found"
        message="It isn't in your library on this device. It may have been deleted."
        actions={
          <Link to="/library" className={buttonClasses()}>
            <LibraryBig aria-hidden="true" />
            Go to your library
          </Link>
        }
      />
    )
  }

  const { playlist, rows } = live.data
  const kind = trackListKind(playlist)
  const ref = { id: playlist.id, name: playlist.name, description: playlist.description }
  const actions: MenuItem[] = []
  if (!playlist.system) {
    actions.push({
      id: 'edit',
      label: 'Edit details…',
      icon: Pencil,
      onSelect: () => dialogs.rename(ref),
    })
  }
  actions.push({
    id: 'duplicate',
    label: 'Duplicate',
    icon: Copy,
    onSelect: () => duplicatePlaylist(ref),
  })
  const downloadable = rows.flatMap((row) =>
    row.track && canDownload(row.track) ? [row.track] : [],
  )
  if (kind !== 'downloads' && downloadable.length > 0) {
    actions.push({
      id: 'download-all',
      label: 'Download all',
      icon: ArrowDownToLine,
      onSelect: () => void downloadTracks(downloadable),
    })
  }
  if (!playlist.system) {
    actions.push({
      id: 'delete',
      label: 'Delete…',
      icon: Trash,
      danger: true,
      onSelect: () => dialogs.remove(ref),
    })
  }

  return (
    <div className="space-y-8">
      <PageWash color={seedWash(`playlist:${playlist.id}`)} />
      <PlaylistHeader view={live.data} />
      <div className="flex items-center justify-center gap-3 sm:justify-start">
        <PlayPauseButton
          appearance="cta"
          collection={{
            tracks: sortTrackRows(rows, view).flatMap((row) =>
              row.track === undefined ? [] : [row.track],
            ),
            context: { type: 'playlist', id: playlist.id, title: playlist.name },
          }}
        />
        <Menu
          label={`More options for ${playlist.name}`}
          iconOnly
          items={actions}
          className={iconButtonClasses({ size: 'lg' })}
          align="start"
        >
          <Ellipsis aria-hidden="true" />
        </Menu>
      </div>
      <TrackList
        listId={playlist.id}
        rows={rows}
        undo={playlist.undo}
        kind={kind}
        name={playlist.name}
        empty={<EmptyList kind={kind} />}
      />
      {dialogs.dialogs}
    </div>
  )
}
