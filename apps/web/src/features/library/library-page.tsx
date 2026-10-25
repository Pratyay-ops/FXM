import type { EntityId, Track } from '@fxm/core'
import {
  ArchiveRestore,
  Clock,
  Disc3,
  Ellipsis,
  Heart,
  ListMusic,
  ListPlus,
  Music,
  Plus,
  Trash,
  UserRound,
} from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { PageTitle } from '../../components/ui/page'
import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import {
  type Live,
  useFollows,
  useLibrary,
  usePlaylistList,
  usePlaylistView,
  useRecentlyPlayed,
} from '../../db/hooks'
import type { RecentRow } from '../../db/repo'
import {
  DOWNLOADS_PLAYLIST_ID,
  type FollowKind,
  type FollowRecord,
  LIKED_PLAYLIST_ID,
} from '../../db/types'
import { BackupDialog } from './backup-dialog'
import { CoverArt } from './cover-art'
import { failureText } from './failure'
import { artistNames, artworkUrl, countLabel, playedLabel, totalDuration } from './format'
import { EmptyList, trackListKind } from './local-playlist-page'
import { followPath, playlistPath } from './paths'
import { AddToPlaylistDialog, usePlaylistDialogs } from './playlist-dialogs'
import { PlaylistList, useUnfollow } from './playlist-list'
import { showStatus } from './status'
import { TrackList } from './track-list'
import { Dialog, DialogActions } from './ui/dialog'
import { Menu } from './ui/menu'
import { neighborAfterRemoval, rowControl, useFocusAfterRemoval } from './use-focus-after-removal'

type LibraryTab = 'playlists' | 'liked' | 'downloads' | 'artists' | 'albums' | 'recent'

const TABS: readonly TabItem<LibraryTab>[] = [
  { value: 'playlists', label: 'Playlists' },
  { value: 'liked', label: 'Liked songs' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'artists', label: 'Artists' },
  { value: 'albums', label: 'Albums' },
  { value: 'recent', label: 'Recently played' },
]

function isLibraryTab(value: unknown): value is LibraryTab {
  return TABS.some((tab) => tab.value === value)
}

/** Rows that stand in while a list loads. */
function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" className="space-y-3 pt-2">
      <span className="sr-only">Loading…</span>
      {placeholderKeys(rows, 'library-row').map((key) => (
        <div key={key} className="flex items-center gap-3">
          <Skeleton className="size-12 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 max-w-72 rounded-full" />
            <Skeleton className="h-3 w-1/3 max-w-40 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** What a list shows while loading or when the database can't be read. */
function LiveState({ live }: { live: Live<unknown> }) {
  if (live.status === 'loading') return <ListSkeleton />
  return (
    <p role="alert" className="py-10 text-center text-text-muted">
      Your library can't be read in this browser window. Private windows and turned-off site data
      can block it.
    </p>
  )
}

function PlaylistsPanel({ onCreate }: { onCreate: () => void }) {
  const live = usePlaylistList()
  const navigate = useNavigate()
  const dialogs = usePlaylistDialogs({ onCreated: (id) => navigate(playlistPath(id)) })
  const unfollow = useUnfollow()
  if (live.status !== 'ready') return <LiveState live={live} />
  const { items, undo } = live.data
  const own = items.filter((item) => item.origin === 'local' && !item.system).length
  return (
    <div className="space-y-6">
      <PlaylistList
        items={items}
        undo={undo}
        actions={{ rename: dialogs.rename, remove: dialogs.remove, unfollow }}
      />
      {own === 0 && (
        <EmptyState
          icon={ListMusic}
          title="Make your first playlist"
          description="Playlists live on this device. Put songs in any order you like and change it whenever you want."
          action={
            <button type="button" className={buttonClasses()} onClick={onCreate}>
              <Plus aria-hidden="true" />
              New playlist
            </button>
          }
          headingLevel={3}
          className="rounded-2xl border border-dashed border-border"
        />
      )}
      {dialogs.dialogs}
    </div>
  )
}

/** Liked songs or Downloads, with their own custom order. */
function BuiltInPanel({ id }: { id: EntityId<'playlist'> }) {
  const live = usePlaylistView(id)
  if (live.status !== 'ready') return <LiveState live={live} />
  if (live.data === undefined) return <LiveState live={{ status: 'error', error: null }} />
  const { playlist, rows } = live.data
  const kind = trackListKind(playlist)
  const duration = totalDuration(rows.map((row) => row.track?.durationMs))
  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
          <span>
            {countLabel(rows.length, 'song')}
            {duration && ` · ${duration}`}
          </span>
          <span aria-hidden="true">·</span>
          {/* A full-height target on touch screens, though it reads as a link in the line. */}
          <Link
            to={playlistPath(id)}
            className="inline-flex h-touch items-center rounded-md font-semibold text-text underline-offset-2 hover:underline lg:h-8 lg:pointer-coarse:h-touch"
          >
            Open as playlist
          </Link>
        </p>
      )}
      <TrackList
        listId={playlist.id}
        rows={rows}
        undo={playlist.undo}
        kind={kind}
        name={playlist.name}
        empty={<EmptyList kind={kind} />}
      />
    </div>
  )
}

const FOLLOW_EMPTY: Record<
  Exclude<FollowKind, 'playlist'>,
  { title: string; description: string }
> = {
  artist: {
    title: 'Follow artists you love',
    description: 'Artists you follow show up here, and their new songs reach your home feed.',
  },
  album: {
    title: 'Save albums to find them fast',
    description: 'Albums you save show up here.',
  },
}

function FollowCard({
  follow,
  onUnfollow,
}: {
  follow: FollowRecord
  onUnfollow: (follow: FollowRecord) => void
}) {
  const kind = follow.kind === 'artist' ? 'artist' : 'album'
  const subtitle =
    kind === 'artist'
      ? 'Artist'
      : (follow.artists?.map((artist) => artist.name).join(', ') ?? 'Album')
  return (
    <li data-row={follow.key} className="relative min-w-0">
      <Link
        to={followPath(kind, follow.id)}
        className="block rounded-lg p-2 hover:bg-text/5 focus-visible:outline-offset-0"
      >
        <CoverArt
          src={artworkUrl(follow.artwork, 360)}
          seed={`${kind}:${follow.id}`}
          icon={kind === 'artist' ? UserRound : Disc3}
          shape={kind === 'artist' ? 'circle' : 'square'}
          className="aspect-square w-full shadow-md"
        />
        {/* pr-10 keeps the text clear of the menu button beside it. */}
        <span className="mt-3 block min-w-0 pr-10">
          <span className="block truncate font-semibold">{follow.name}</span>
          <span className="block truncate text-sm text-text-muted">{subtitle}</span>
        </span>
      </Link>
      <span className="absolute right-1 bottom-2">
        <Menu
          label={`More options for ${follow.name}`}
          iconOnly
          className={iconButtonClasses({ size: 'sm' })}
          items={[
            {
              id: 'unfollow',
              label: kind === 'artist' ? 'Unfollow' : 'Remove from your library',
              icon: Trash,
              onSelect: () => onUnfollow(follow),
            },
          ]}
        >
          <Ellipsis aria-hidden="true" />
        </Menu>
      </span>
    </li>
  )
}

const NO_KEYS: readonly string[] = []

function FollowsPanel({ kind }: { kind: Exclude<FollowKind, 'playlist'> }) {
  const live = useFollows(kind)
  const repo = useLibrary()
  const keys = useMemo(
    () => (live.status === 'ready' ? live.data.map((follow) => follow.key) : NO_KEYS),
    [live],
  )
  const listRef = useRef<HTMLUListElement>(null)
  const focusAfter = useFocusAfterRemoval(keys)
  const unfollow = (follow: FollowRecord) => {
    // The card goes, and its menu button with it: the next card's gets focus, or the panel.
    const neighbor = neighborAfterRemoval(keys, new Set([follow.key]))
    const panel = listRef.current?.closest<HTMLElement>('[role="tabpanel"]')
    focusAfter.expect(
      [follow.key],
      () => rowControl(listRef.current, neighbor, 'button[aria-haspopup="menu"]') ?? panel,
    )
    repo.unfollow(follow.id).then(
      () => showStatus(`Removed ${follow.name} from your library`),
      (error: unknown) => {
        focusAfter.cancel()
        showStatus(failureText(error))
      },
    )
  }
  if (live.status !== 'ready') return <LiveState live={live} />
  if (live.data.length === 0) {
    return (
      <EmptyState
        icon={kind === 'artist' ? UserRound : Disc3}
        title={FOLLOW_EMPTY[kind].title}
        description={FOLLOW_EMPTY[kind].description}
        headingLevel={3}
        className="rounded-2xl border border-dashed border-border"
      />
    )
  }
  return (
    <ul
      ref={listRef}
      aria-label={kind === 'artist' ? 'Artists you follow' : 'Saved albums'}
      className="-mx-2 grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
    >
      {live.data.map((follow) => (
        <FollowCard key={follow.key} follow={follow} onUnfollow={unfollow} />
      ))}
    </ul>
  )
}

function RecentRowItem({ row, onAdd }: { row: RecentRow; onAdd: (track: Track) => void }) {
  const repo = useLibrary()
  const title = row.track?.title ?? 'Unavailable song'
  return (
    <li className="flex items-center gap-3 rounded-lg py-1.5 pr-1 pl-2 hover:bg-text/5">
      <CoverArt
        src={artworkUrl(row.track?.artwork, 80)}
        seed={row.id}
        icon={Music}
        rounded="sm"
        className="size-10"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{title}</p>
        <p className="truncate text-sm text-text-muted">{artistNames(row.track)}</p>
      </div>
      <p className="hidden shrink-0 text-sm text-text-muted sm:block">
        {playedLabel(row.playedAt)}
      </p>
      <span className="hidden md:block">
        <IconButton
          label={`Like ${title}`}
          icon={<Heart fill={row.liked ? 'currentColor' : 'none'} />}
          size="sm"
          pressed={row.liked}
          disabled={row.track === undefined && !row.liked}
          onClick={() => {
            const done = row.track ? repo.toggleLike(row.track) : repo.unlike(row.id)
            done.catch((error: unknown) => showStatus(failureText(error)))
          }}
        />
      </span>
      <Menu
        label={`More options for ${title}`}
        iconOnly
        className={iconButtonClasses({ size: 'sm' })}
        items={[
          {
            id: 'add',
            label: 'Add to playlist…',
            icon: ListPlus,
            disabled: row.track === undefined,
            onSelect: () => row.track && onAdd(row.track),
          },
          {
            id: 'like',
            label: row.liked ? 'Remove from Liked songs' : 'Save to Liked songs',
            icon: Heart,
            disabled: row.track === undefined && !row.liked,
            onSelect: () => {
              const done = row.track ? repo.toggleLike(row.track) : repo.unlike(row.id)
              done.catch((error: unknown) => showStatus(failureText(error)))
            },
          },
        ]}
      >
        <Ellipsis aria-hidden="true" />
      </Menu>
    </li>
  )
}

function RecentPanel() {
  const live = useRecentlyPlayed(50)
  const repo = useLibrary()
  const [adding, setAdding] = useState<Track[] | null>(null)
  const [clearing, setClearing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // After clearing, the button that opened the dialog is gone with the list: the tab panel,
  // which then shows the empty state, gets focus.
  const afterClear = useRef<HTMLElement | null>(null)
  if (live.status !== 'ready') return <LiveState live={live} />
  return (
    <div ref={root} className="space-y-3">
      {live.data.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="Nothing played yet"
          description="Songs you play show up here, most recent first. Your listening history stays on this device."
          headingLevel={3}
          className="rounded-2xl border border-dashed border-border"
        />
      ) : (
        <>
          <div className="flex justify-end">
            <button
              type="button"
              className={buttonClasses({ variant: 'ghost' })}
              onClick={() => setClearing(true)}
            >
              <Trash aria-hidden="true" />
              Clear history
            </button>
          </div>
          <ol aria-label="Recently played" className="-mx-1">
            {live.data.map((row) => (
              <RecentRowItem key={row.id} row={row} onAdd={(track) => setAdding([track])} />
            ))}
          </ol>
        </>
      )}
      <AddToPlaylistDialog tracks={adding} onClose={() => setAdding(null)} />
      <Dialog
        open={clearing}
        onClose={() => setClearing(false)}
        alert
        finalFocus={() => {
          const target = afterClear.current
          afterClear.current = null
          return target
        }}
        title="Clear listening history?"
        description="Recently played starts over, and recommendations forget what you played. Your playlists and likes stay."
      >
        <DialogActions>
          {/* Focus starts on Cancel: an extra Enter clears nothing. */}
          <button
            type="button"
            data-autofocus=""
            className={buttonClasses({ variant: 'ghost' })}
            onClick={() => setClearing(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={buttonClasses({ variant: 'danger' })}
            onClick={() => {
              afterClear.current = root.current?.closest<HTMLElement>('[role="tabpanel"]') ?? null
              repo.clearHistory().then(
                () => showStatus('Cleared your listening history'),
                (error: unknown) => showStatus(failureText(error)),
              )
              setClearing(false)
            }}
          >
            Clear history
          </button>
        </DialogActions>
      </Dialog>
    </div>
  )
}

/** The Library: playlists, Liked songs, Downloads, artists, albums and recently played. */
export function LibraryPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab: LibraryTab = isLibraryTab(requested) ? requested : 'playlists'
  const tabsId = useId()
  const navigate = useNavigate()
  const dialogs = usePlaylistDialogs({ onCreated: (id) => navigate(playlistPath(id)) })
  const [backup, setBackup] = useState(false)

  return (
    <div className="space-y-6 pt-2 md:pt-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <PageTitle hideOnPhone className="mr-auto">
          Your library
        </PageTitle>
        <button type="button" className={buttonClasses()} onClick={dialogs.create}>
          <Plus aria-hidden="true" />
          New playlist
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setBackup(true)}
        >
          <ArchiveRestore aria-hidden="true" />
          Backup
        </button>
      </div>
      <Tabs
        label="Library"
        id={tabsId}
        items={TABS}
        value={tab}
        onChange={(next) => setParams(next === 'playlists' ? {} : { tab: next }, { replace: true })}
      />
      <TabPanel id={tabsId} value={tab}>
        {tab === 'playlists' && <PlaylistsPanel onCreate={dialogs.create} />}
        {tab === 'liked' && <BuiltInPanel id={LIKED_PLAYLIST_ID} />}
        {tab === 'downloads' && <BuiltInPanel id={DOWNLOADS_PLAYLIST_ID} />}
        {tab === 'artists' && <FollowsPanel kind="artist" />}
        {tab === 'albums' && <FollowsPanel kind="album" />}
        {tab === 'recent' && <RecentPanel />}
      </TabPanel>
      <BackupDialog open={backup} onClose={() => setBackup(false)} />
      {dialogs.dialogs}
    </div>
  )
}
