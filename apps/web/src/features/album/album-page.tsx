import {
  applyModeFilter,
  type EntityId,
  isFxmError,
  type MetadataProvider,
  parseId,
} from '@fxm/core'
import { MicVocal } from 'lucide-react'
import { useParams } from 'react-router'
import { useMediaActions } from '../search/actions'
import { Byline, useEntityTitle } from '../search/catalog/byline'
import { CollectionToolbar } from '../search/catalog/collection-toolbar'
import { EntityHeader, EntityPageSkeleton } from '../search/catalog/entity-header'
import {
  albumTypeLabel,
  countLabel,
  formatTotalDuration,
  releaseYear,
  totalDuration,
} from '../search/catalog/format'
import { artistPath, parseRouteId } from '../search/catalog/links'
import { CatalogOverlays } from '../search/catalog/overlays'
import { EntityLoadError, EntityNotFound, SourceUnavailable } from '../search/catalog/states'
import { ArtistLinks, TrackList } from '../search/catalog/track-list'
import { useAlbum } from '../search/queries'
import { sourceAvailability } from '../search/sources'
import { useSourcesSnapshot } from '../search/sources-context'
import { useSettingsStore } from '../settings/settings-store'
import { albumShareItems } from '../share/share-menu'

function AlbumContent({ id, provider }: { id: EntityId<'album'>; provider: MetadataProvider }) {
  const album = useAlbum(id, provider)
  const mode = useSettingsStore((state) => state.catalogMode)
  const { playback } = useMediaActions()
  useEntityTitle(album.data?.name)

  if (album.data === undefined) {
    if (!album.isError) return <EntityPageSkeleton label="Loading album" />
    return isFxmError(album.error, 'NotFound') ? (
      <EntityNotFound kind="album" />
    ) : (
      <EntityLoadError
        kind="album"
        error={album.error}
        source={parseId(id).source}
        onRetry={() => void album.refetch()}
      />
    )
  }

  const { data } = album
  const tracks = applyModeFilter(data.tracks ?? [], mode)
  const context = { type: 'album', id: data.id, title: data.name } as const
  const total = totalDuration(tracks)
  const artist = data.artists.find((candidate) => candidate.id !== undefined)

  return (
    <div className="space-y-8">
      <EntityHeader
        kind={albumTypeLabel(data.type)}
        name={data.name}
        source={data.source}
        artwork={data.artwork}
        seed={data.id}
        explicit={data.explicit}
      >
        <Byline
          items={[
            ['artists', <ArtistLinks key="artists" artists={data.artists} />],
            ['year', releaseYear(data.releaseDate)],
            [
              'size',
              total === undefined
                ? countLabel(tracks.length, 'song')
                : `${countLabel(tracks.length, 'song')}, ${formatTotalDuration(total)}`,
            ],
          ]}
        />
      </EntityHeader>
      <CollectionToolbar
        name={data.name}
        source={data.source}
        tracks={tracks}
        context={context}
        extraItems={[
          ...(artist?.id
            ? [{ key: 'artist', label: 'Go to artist', icon: MicVocal, to: artistPath(artist.id) }]
            : []),
          ...albumShareItems(data, tracks),
        ]}
      />
      {tracks.length > 0 ? (
        <TrackList
          tracks={tracks}
          label="Tracks"
          numbered
          onPlay={
            playback ? (index) => playback.play(tracks, { startIndex: index, context }) : undefined
          }
        />
      ) : (
        <p className="text-sm text-text-muted">
          {mode === 'music' ? 'No songs on this album play in Music mode.' : 'This album is empty.'}
        </p>
      )}
      <CatalogOverlays />
    </div>
  )
}

function AlbumView({ id }: { id: EntityId<'album'> }) {
  const snapshot = useSourcesSnapshot()
  const { source } = parseId(id)
  const availability = sourceAvailability(snapshot, source)
  return availability.status === 'available' ? (
    <AlbumContent id={id} provider={availability.provider} />
  ) : (
    <SourceUnavailable availability={availability} source={source} kind="album" />
  )
}

/** An album: its tracks, with play, shuffle, queue and add-to-playlist actions. */
export function AlbumPage() {
  const { id: param } = useParams()
  const id = parseRouteId(param, 'album')
  if (id === null) return <EntityNotFound kind="album" />
  return <AlbumView key={id} id={id} />
}
