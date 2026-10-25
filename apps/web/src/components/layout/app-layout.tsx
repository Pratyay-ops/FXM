import { APP_NAME } from '@fxm/core'
import { useRef } from 'react'
import { Outlet, ScrollRestoration, useLocation, useNavigation } from 'react-router'
import { PlaybackAnnouncer } from '../../features/now-playing/playback-problem'
import { MiniPlayer, PlayerBar } from '../../features/player/player-bar'
import { BottomNav } from './bottom-nav'
import { RouteAnnouncer } from './route-announcer'
import { useDocumentTitle, useRouteHandle } from './route-meta'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'

/** Thin bar along the top while a route's code loads (fades in only if it is slow). */
function NavigationProgress() {
  const navigation = useNavigation()
  if (navigation.state === 'idle') return null
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity delay-150 duration-300 starting:opacity-0"
    >
      <div className="h-full w-2/5 animate-progress rounded-full bg-accent" />
    </div>
  )
}

/**
 * The app frame: sidebar (768px+), top bar, scrolling page, player bar (768px+),
 * and on phones a mini player above the tab bar. Pages render into <Outlet />.
 * On phones, Now playing fills the screen: no mini player or tab bar (the top
 * bar's back arrow leaves it), which `data-full-screen` tells the CSS.
 */
export function AppLayout() {
  const handle = useRouteHandle()
  useDocumentTitle(handle)
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  const fullScreen = pathname === '/now-playing'

  return (
    <>
      {/* biome-ignore lint/a11y/useValidAnchor: a skip link is an in-page link (href="#main"); the handler only replaces the browser's jump */}
      <a
        href="#main"
        onClick={(event) => {
          // Focus <main> directly: the browser's own jump to #main would add a history
          // entry without React Router's state, which breaks Back and the history index.
          event.preventDefault()
          main.current?.focus()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-accent focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-on-accent"
      >
        Skip to content
      </a>
      <NavigationProgress />
      <RouteAnnouncer title={handle?.title ?? APP_NAME} />
      <Sidebar />
      <div className="md:pl-rail lg:pl-sidebar">
        <TopBar handle={handle} />
        {/* `relative`: page washes (PageWash) span the whole column, also past max-w-page. */}
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          data-full-screen={fullScreen || undefined}
          className="relative isolate px-gutter pt-2 pb-shell outline-none"
        >
          <div className="mx-auto w-full max-w-page">
            <Outlet />
          </div>
        </main>
      </div>
      <PlayerBar />
      {/* Now Playing has its own big controls on phones. */}
      {!fullScreen && <MiniPlayer />}
      {!fullScreen && <BottomNav />}
      <PlaybackAnnouncer />
      <ScrollRestoration />
    </>
  )
}
