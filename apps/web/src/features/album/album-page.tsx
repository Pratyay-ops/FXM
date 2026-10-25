import { useParams } from 'react-router'
import { CollectionActions } from '../../components/media/collection-actions'
import { CollectionHeader, PageWash, seedWash } from '../../components/media/collection-header'
import { TrackListSkeleton } from '../../components/media/placeholders'
import { PlayPauseButton } from '../player/controls'
import { pageEntityId, ShareButton } from '../share/share-button'

export function AlbumPage() {
  const { id = '' } = useParams()
  const seed = `album:${id}`
  return (
    <div className="space-y-8">
      <PageWash color={seedWash(seed)} />
      <CollectionHeader kind="Album" id={id} seed={seed} />
      <CollectionActions toggle="save">
        <PlayPauseButton appearance="cta" />
        <ShareButton id={pageEntityId('album', id)} info={{ title: 'Album' }} />
      </CollectionActions>
      <section aria-label="Tracks">
        <p className="sr-only">The track list appears here once sources are connected.</p>
        <TrackListSkeleton count={10} />
      </section>
    </div>
  )
}
