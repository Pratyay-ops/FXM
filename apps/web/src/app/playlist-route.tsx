import { Navigate, useParams } from 'react-router'
import { isLocalPlaylistId } from '../db/types'
import { LocalPlaylistPage } from '../features/library/local-playlist-page'
import { playlistPath } from '../features/library/paths'
import { PlaylistPage } from '../features/playlist/playlist-page'
import { parseRouteId } from '../features/search/catalog/links'

/**
 * `/playlist/:id`: a playlist of this library (`local:playlist:…`) opens the library's page
 * (stage 2.6); any other source's playlist opens the playlist page (stage 2.4). A link to a
 * library playlist built the way other sources' are (`/playlist/local:<native ID>`, by
 * `playlistPath` in `features/search/catalog/links.ts`) moves to the library's own address.
 */
export function PlaylistRoute() {
  const { id = '' } = useParams()
  // Keyed by the ID, so moving between two playlists starts each page fresh.
  if (isLocalPlaylistId(id)) return <LocalPlaylistPage key={id} id={id} />
  const named = parseRouteId(id, 'playlist')
  if (named !== null && isLocalPlaylistId(named)) {
    return <Navigate replace to={playlistPath(named)} />
  }
  return <PlaylistPage />
}
