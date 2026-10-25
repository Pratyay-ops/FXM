import { FeedbackToast } from '../feedback'
import { AddToPlaylistDialog } from './add-to-playlist'

/**
 * What the catalog pages show on top of themselves: the add-to-playlist dialog and the
 * confirmation toast. Every search, album, artist and playlist page renders it once.
 */
export function CatalogOverlays() {
  return (
    <>
      <AddToPlaylistDialog />
      <FeedbackToast />
    </>
  )
}
