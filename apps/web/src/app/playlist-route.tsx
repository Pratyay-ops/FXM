import { useParams } from 'react-router'
import { isLocalPlaylistId } from '../db/types'
import { LocalPlaylistPage } from '../features/library/local-playlist-page'
import { PlaylistPage } from '../features/playlist/playlist-page'

/**
 * `/playlist/:id`: a playlist of this library (`local:playlist:…`) opens the library's page
 * (stage 2.6); any other source's playlist opens the playlist page (stage 2.4).
 */
export function PlaylistRoute() {
  const { id = '' } = useParams()
  // Keyed by the ID, so moving between two playlists starts each page fresh.
  return isLocalPlaylistId(id) ? <LocalPlaylistPage key={id} id={id} /> : <PlaylistPage />
}
