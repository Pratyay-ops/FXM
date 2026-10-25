import { Outlet, ScrollRestoration, useLocation, useNavigation } from 'react-router'
import { MiniPlayer, PlayerBar } from '../../features/player/player-bar'
import { BottomNav } from './bottom-nav'
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
 */
export function AppLayout() {
  const handle = useRouteHandle()
  useDocumentTitle(handle)
  const { pathname } = useLocation()

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-accent focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-on-accent"
      >
        Skip to content
      </a>
      <NavigationProgress />
      <Sidebar />
      <div className="md:pl-rail lg:pl-sidebar">
        <TopBar handle={handle} />
        <main id="main" tabIndex={-1} className="isolate px-gutter pt-2 pb-shell outline-none">
          <div className="relative mx-auto w-full max-w-[96rem]">
            <Outlet />
          </div>
        </main>
      </div>
      <PlayerBar />
      {/* Now Playing has its own big controls on phones. */}
      {pathname !== '/now-playing' && <MiniPlayer />}
      <BottomNav />
      <ScrollRestoration />
    </>
  )
}
