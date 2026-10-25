import {
  applyModeFilter,
  type EntityId,
  isFxmError,
  type MetadataProvider,
  parseId,
} from '@fxm/core'
import { MicVocal } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { Shelf } from '../../components/ui/page'
import { useMediaActions } from '../search/actions'
import { useEntityTitle } from '../search/catalog/byline'
import { CollectionToolbar } from '../search/catalog/collection-toolbar'
import { EntityHeader, EntityPageSkeleton } from '../search/catalog/entity-header'
import { albumCardSubtitle, CardShelf, EntityCard } from '../search/catalog/entity-list'
import { albumPath, artistPath, parseRouteId } from '../search/catalog/links'
import { CatalogOverlays } from '../search/catalog/overlays'
import { EntityLoadError, EntityNotFound, SourceUnavailable } from '../search/catalog/states'
import { TrackList } from '../search/catalog/track-list'
import { useArtist, useRelatedArtists } from '../search/queries'
import { sourceAvailability } from '../search/sources'
import { useSourcesSnapshot } from '../search/sources-context'
import { useSettingsStore } from '../settings/settings-store'

/** Popular tracks shown before "Show more". */
const TOP_TRACKS_SHOWN = 5

function ArtistContent({ id, provider }: { id: EntityId<'artist'>; provider: MetadataProvider }) {
  const artist = useArtist(id, provider)
  // Some sources (Spotify) list similar artists apart from the artist page.
  const related = useRelatedArtists(
    id,
    provider,
    artist.data !== undefined && artist.data.related === undefined,
  )
  const mode = useSettingsStore((state) => state.catalogMode)
  const { playback } = useMediaActions()
  const [showAllTop, setShowAllTop] = useState(false)
  useEntityTitle(artist.data?.name)

  if (artist.data === undefined) {
    if (!artist.isError) return <EntityPageSkeleton label="Loading artist" shape="circle" />
    return isFxmError(artist.error, 'NotFound') ? (
      <EntityNotFound kind="artist" />
    ) : (
      <EntityLoadError
        kind="artist"
        error={artist.error}
        source={parseId(id).source}
        onRetry={() => void artist.refetch()}
      />
    )
  }

  const { data } = artist
  const topTracks = applyModeFilter(data.topTracks ?? [], mode)
  const shownTop = showAllTop ? topTracks : topTracks.slice(0, TOP_TRACKS_SHOWN)
  const albums = data.albums ?? []
  const similar = data.related ?? related.data ?? []
  const context = { type: 'artist', id: data.id, title: data.name } as const

  return (
    <div className="space-y-10">
      <div className="space-y-8">
        <EntityHeader
          kind="Artist"
          name={data.name}
          source={data.source}
          artwork={data.artwork}
          seed={data.id}
          shape="circle"
          icon={MicVocal}
        />
        <CollectionToolbar name={data.name} tracks={topTracks} context={context} />
      </div>

      {topTracks.length > 0 && (
        <Shelf title="Popular">
          <TrackList
            tracks={shownTop}
            label="Popular songs"
            showAlbum
            onPlay={
              playback
                ? (index) => playback.play(topTracks, { startIndex: index, context })
                : undefined
            }
          />
          {topTracks.length > TOP_TRACKS_SHOWN && (
            <button
              type="button"
              aria-expanded={showAllTop}
              onClick={() => setShowAllTop(!showAllTop)}
              className={buttonClasses({ variant: 'ghost', className: 'px-3' })}
            >
              {showAllTop ? 'Show less' : 'Show more'}
            </button>
          )}
        </Shelf>
      )}

      {albums.length > 0 && (
        <Shelf title="Albums and singles">
          <CardShelf items={albums} label="Albums and singles">
            {(album) => (
              <EntityCard
                to={albumPath(album.id)}
                title={album.name}
                subtitle={albumCardSubtitle(album)}
                artwork={album.artwork}
                seed={album.id}
              />
            )}
          </CardShelf>
        </Shelf>
      )}

      {similar.length > 0 && (
        <Shelf title="Fans also like">
          <CardShelf items={similar} label="Similar artists">
            {(other) => (
              <EntityCard
                to={artistPath(other.id)}
                title={other.name}
                subtitle="Artist"
                artwork={other.artwork}
                seed={other.id}
                shape="circle"
                icon={MicVocal}
              />
            )}
          </CardShelf>
        </Shelf>
      )}

      {data.description && (
        <Shelf title="About">
          <p className="max-w-3xl whitespace-pre-line text-text-muted">{data.description}</p>
        </Shelf>
      )}
      <CatalogOverlays />
    </div>
  )
}

function ArtistView({ id }: { id: EntityId<'artist'> }) {
  const snapshot = useSourcesSnapshot()
  const { source } = parseId(id)
  const availability = sourceAvailability(snapshot, source)
  return availability.status === 'available' ? (
    <ArtistContent id={id} provider={availability.provider} />
  ) : (
    <SourceUnavailable availability={availability} source={source} kind="artist" />
  )
}

/** An artist: popular tracks, releases and similar artists, with play and queue actions. */
export function ArtistPage() {
  const { id: param } = useParams()
  const id = parseRouteId(param, 'artist')
  if (id === null) return <EntityNotFound kind="artist" />
  return <ArtistView key={id} id={id} />
}
