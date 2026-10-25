import { useParams } from 'react-router'
import { PLACEHOLDER_PLAYLISTS } from '../../components/layout/nav-items'
import { CollectionActions } from '../../components/media/collection-actions'
import { CollectionHeader, PageWash, seedWash } from '../../components/media/collection-header'
import { TrackListSkeleton } from '../../components/media/placeholders'
import { PlayPauseButton } from '../player/controls'

export function PlaylistPage() {
  const { id = '' } = useParams()
  // Same seed and icon as the sidebar entry, so the artwork matches.
  const seed = `playlist:${id}`
  const icon = PLACEHOLDER_PLAYLISTS.find((playlist) => playlist.id === id)?.icon
  return (
    <div className="space-y-8">
      <PageWash color={seedWash(seed)} />
      <CollectionHeader kind="Playlist" id={id} seed={seed} icon={icon} />
      <CollectionActions toggle="save">
        <PlayPauseButton appearance="cta" />
      </CollectionActions>
      <section aria-label="Tracks">
        <p className="sr-only">The track list appears here once sources are connected.</p>
        <TrackListSkeleton count={10} />
      </section>
    </div>
  )
}
