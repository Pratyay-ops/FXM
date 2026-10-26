import { AddToPlaylistDialog } from './add-to-playlist'

/**
 * What the catalog pages show on top of themselves: the add-to-playlist dialog. Every search,
 * album, artist and playlist page renders it once. Their confirmations go to the app's one toast
 * (`FeedbackToast`), which the shell renders on every page.
 */
export function CatalogOverlays() {
  return <AddToPlaylistDialog />
}
