import type { RouteObject } from 'react-router'
import { AppLayout } from '../components/layout/app-layout'
import type { RouteHandle } from '../components/layout/route-meta'
import { PageSkeleton } from '../components/ui/skeleton'
import { HomePage } from '../features/home/home-page'
import { SearchPage } from '../features/search/search-page'
import { RootError, RouteError } from './errors'
import { NotFoundPage } from './not-found-page'

const page = (title: string): RouteHandle => ({ title })
const tab = (title: string): RouteHandle => ({ title, tab: true })

/**
 * The route tree (paths are relative to the /app/ basename).
 *
 * Home ships with the shell because most visits start there, and Search because
 * the first keystroke in the top bar opens it: a lazy chunk would flash a loading
 * state there and commit the URL in a transition, so the next keystroke could push
 * a second history entry. Every other page is a lazy chunk. To add a page, create
 * it under src/features/<name>/ and add a route below (see the README). Use the
 * function form of `lazy`: React Router mutates the object form after loading,
 * which breaks a second router (tests, HMR).
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    // The shell itself failed: show a full-page error.
    errorElement: <RootError />,
    children: [
      {
        // Page errors and loading states render inside the shell, which keeps working.
        errorElement: <RouteError />,
        hydrateFallbackElement: <PageSkeleton />,
        children: [
          { index: true, handle: tab('Home'), element: <HomePage /> },
          { path: 'search', handle: tab('Search'), element: <SearchPage /> },
          {
            path: 'library',
            handle: tab('Library'),
            lazy: () =>
              import('../features/library/library-page').then((m) => ({
                Component: m.LibraryPage,
              })),
          },
          {
            path: 'album/:id',
            handle: page('Album'),
            lazy: () =>
              import('../features/album/album-page').then((m) => ({ Component: m.AlbumPage })),
          },
          {
            path: 'artist/:id',
            handle: page('Artist'),
            lazy: () =>
              import('../features/artist/artist-page').then((m) => ({ Component: m.ArtistPage })),
          },
          {
            // Local playlists (the library, 2.6) and other sources' playlists (2.4).
            path: 'playlist/:id',
            handle: page('Playlist'),
            lazy: () => import('./playlist-route').then((m) => ({ Component: m.PlaylistRoute })),
          },
          {
            path: 'now-playing',
            handle: page('Now playing'),
            lazy: () =>
              import('../features/now-playing/now-playing-page').then((m) => ({
                Component: m.NowPlayingPage,
              })),
          },
          {
            path: 'settings',
            handle: page('Settings'),
            lazy: () =>
              import('../features/settings/settings-page').then((m) => ({
                Component: m.SettingsPage,
              })),
          },
          { path: '*', handle: page('Page not found'), element: <NotFoundPage /> },
        ],
      },
    ],
  },
]
