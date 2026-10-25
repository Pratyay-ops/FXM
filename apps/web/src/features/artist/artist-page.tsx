import { MicVocal } from 'lucide-react'
import { useParams } from 'react-router'
import { CollectionActions } from '../../components/media/collection-actions'
import { CollectionHeader, PageWash, seedWash } from '../../components/media/collection-header'
import { CardScroller, TrackListSkeleton } from '../../components/media/placeholders'
import { Shelf } from '../../components/ui/page'
import { PlayPauseButton } from '../player/controls'

export function ArtistPage() {
  const { id = '' } = useParams()
  const seed = `artist:${id}`
  return (
    <div className="space-y-10">
      <PageWash color={seedWash(seed)} />
      <div className="space-y-8">
        <CollectionHeader kind="Artist" id={id} seed={seed} shape="circle" icon={MicVocal} />
        <CollectionActions toggle="follow">
          <PlayPauseButton appearance="cta" />
        </CollectionActions>
      </div>
      <Shelf title="Popular">
        <TrackListSkeleton count={5} />
      </Shelf>
      <Shelf title="Albums and singles">
        <CardScroller count={8} />
      </Shelf>
      <Shelf title="Fans also like">
        <CardScroller count={8} shape="circle" />
      </Shelf>
    </div>
  )
}
