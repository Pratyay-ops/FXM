import {
  applyModeFilter,
  type EntityId,
  isFxmError,
  type MetadataProvider,
  parseId,
} from '@fxm/core'
import { ListMusic } from 'lucide-react'
import { useRef } from 'react'
import { Navigate, useParams } from 'react-router'
import { SYSTEM_PLAYLIST_IDS, type SystemPlaylist } from '../../db/types'
import { playlistPath } from '../library/paths'
import { useMediaActions } from '../search/actions'
import { Byline, useEntityTitle } from '../search/catalog/byline'
import { CollectionToolbar } from '../search/catalog/collection-toolbar'
import { EntityHeader, EntityPageSkeleton } from '../search/catalog/entity-header'
import { countLabel } from '../search/catalog/format'
import { parseRouteId } from '../search/catalog/links'
import { CatalogOverlays } from '../search/catalog/overlays'
import { ShowMoreButton, useShowMore } from '../search/catalog/show-more'
import {
  EntityLoadError,
  EntityNotFound,
  InlineError,
  SourceUnavailable,
} from '../search/catalog/states'
import { TrackList } from '../search/catalog/track-list'
import { usePlaylist } from '../search/queries'
import { sourceAvailability } from '../search/sources'
import { useSourcesSnapshot } from '../search/sources-context'
import { useSettingsStore } from '../settings/settings-store'
import { playlistShareItems } from '../share/share-menu'

/** Says what Music mode leaves out of the playlist, with a way to see it. */
function HiddenInMusicMode({ count }: { count?: number }) {
  const setCatalogMode = useSettingsStore((state) => state.setCatalogMode)
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
      {count === undefined
        ? 'Nothing in this playlist plays in Music mode.'
        : `${countLabel(count, 'track')} hidden in Music mode.`}
      <button
        type="button"
        onClick={() => setCatalogMode('all')}
        className="inline-flex h-touch items-center font-semibold text-text underline underline-offset-2 lg:h-auto lg:pointer-coarse:h-touch"
      >
        Switch to Music + Video
      </button>
    </p>
  )
}

function PlaylistContent({
  id,
  provider,
}: {
  id: EntityId<'playlist'>
  provider: MetadataProvider
}) {
  const pages = usePlaylist(id, provider)
  const mode = useSettingsStore((state) => state.catalogMode)
  const { playback } = useMediaActions()
  const list = useRef<HTMLDivElement>(null)
  const playlist = pages.data?.pages[0]?.playlist
  // A playlist may hold the same track twice: keep every entry (the list keys tell them apart).
  const loaded = (pages.data?.pages ?? []).flatMap((page) => page.tracks.items)
  const tracks = applyModeFilter(loaded, mode)
  const { showMore, loaded: loadedMore } = useShowMore({
    count: tracks.length,
    isFetching: pages.isFetchingNextPage,
    failed: pages.isFetchNextPageError,
    fetchNextPage: pages.fetchNextPage,
    list,
    listKey: mode,
  })
  useEntityTitle(playlist?.name)
  const { source } = parseId(id)

  if (playlist === undefined) {
    if (!pages.isError) return <EntityPageSkeleton label="Loading playlist" />
    return isFxmError(pages.error, 'NotFound') ? (
      <EntityNotFound kind="playlist" />
    ) : (
      <EntityLoadError
        kind="playlist"
        error={pages.error}
        source={source}
        onRetry={() => void pages.refetch()}
      />
    )
  }

  const total = playlist.trackCount ?? playlist.tracks?.total
  const complete = !pages.hasNextPage
  // What Music mode leaves out is known only once every page is in: the provider may have
  // left it out already, so count what the playlist holds against what shows.
  const hidden =
    mode === 'music' && complete && total !== undefined ? Math.max(0, total - tracks.length) : 0
  const context = { type: 'playlist', id: playlist.id, title: playlist.name } as const

  return (
    <div className="space-y-8">
      <EntityHeader
        kind="Playlist"
        name={playlist.name}
        source={playlist.source}
        artwork={playlist.artwork}
        seed={playlist.id}
        icon={ListMusic}
      >
        {playlist.description && (
          <p className="mb-2 max-w-2xl text-balance whitespace-pre-line">{playlist.description}</p>
        )}
        <Byline
          items={[
            ['owner', playlist.owner?.name],
            [
              'size',
              total === undefined
                ? undefined
                : hidden > 0
                  ? `${tracks.length.toLocaleString('en')} of ${countLabel(total, 'song')}`
                  : countLabel(total, 'song'),
            ],
          ]}
        />
      </EntityHeader>
      <CollectionToolbar
        name={playlist.name}
        source={playlist.source}
        tracks={tracks}
        context={context}
        extraItems={playlistShareItems(playlist, tracks, total)}
      />
      <div ref={list} className="space-y-6">
        {tracks.length > 0 ? (
          <TrackList
            tracks={tracks}
            label="Tracks"
            numbered
            showAlbum
            onPlay={
              playback
                ? (index) => playback.play(tracks, { startIndex: index, context })
                : undefined
            }
          />
        ) : (
          complete &&
          (mode === 'music' ? (
            <HiddenInMusicMode />
          ) : (
            <p className="text-sm text-text-muted">This playlist is empty.</p>
          ))
        )}
        {tracks.length > 0 && hidden > 0 && <HiddenInMusicMode count={hidden} />}
        {pages.isFetchNextPageError ? (
          <InlineError error={pages.error} source={source} onRetry={showMore} />
        ) : (
          pages.hasNextPage && (
            <ShowMoreButton loading={pages.isFetchingNextPage} onClick={showMore}>
              Show more tracks
            </ShowMoreButton>
          )
        )}
        <p role="status" className="sr-only">
          {loadedMore
            ? `${loadedMore.added} more ${loadedMore.added === 1 ? 'track' : 'tracks'} loaded, ${loadedMore.total} in all`
            : ''}
        </p>
      </div>
      <CatalogOverlays />
    </div>
  )
}

function PlaylistView({ id }: { id: EntityId<'playlist'> }) {
  const snapshot = useSourcesSnapshot()
  const { source } = parseId(id)
  const availability = sourceAvailability(snapshot, source)
  return availability.status === 'available' ? (
    <PlaylistContent id={id} provider={availability.provider} />
  ) : (
    <SourceUnavailable availability={availability} source={source} kind="playlist" />
  )
}

/** Whether a bare playlist ID is one of the library's built-in playlists: `liked`, `downloads`. */
function isSystemPlaylist(id: string): id is SystemPlaylist {
  return Object.hasOwn(SYSTEM_PLAYLIST_IDS, id)
}

/**
 * A playlist from a catalog (`/playlist/<source>:<id>`): its tracks a page at a time, with play,
 * shuffle, queue and add-to-playlist actions. The shell's old addresses of the library's
 * built-in playlists, a bare `liked` or `downloads`, lead to their pages in the library; any
 * other address that isn't a catalog ID is not found.
 */
export function PlaylistPage() {
  const { id: param = '' } = useParams()
  const id = parseRouteId(param, 'playlist')
  if (id !== null) return <PlaylistView key={id} id={id} />
  if (isSystemPlaylist(param)) {
    return <Navigate replace to={playlistPath(SYSTEM_PLAYLIST_IDS[param])} />
  }
  return <EntityNotFound kind="playlist" />
}
