import { useId } from 'react'
import { Link, NavLink } from 'react-router'
import { cn } from '../../lib/cn'
import { Artwork } from '../ui/artwork'
import { LogoMark, Wordmark } from '../ui/logo'
import { type NavItem, PLACEHOLDER_PLAYLISTS, PRIMARY_NAV } from './nav-items'

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      className={({ isActive }) =>
        cn(
          'flex h-11 items-center gap-4 rounded-lg px-3 text-[0.9375rem] font-semibold transition-colors max-lg:justify-center lg:px-4',
          isActive ? 'bg-elevated text-text' : 'text-text-muted hover:bg-text/6 hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            aria-hidden="true"
            className={cn('size-6 shrink-0', isActive && 'text-accent')}
            strokeWidth={isActive ? 2.4 : 2}
          />
          <span className="sr-only lg:not-sr-only">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

/** Left sidebar from 768px: an icon rail on tablets, labels from 1024px. */
export function Sidebar() {
  const playlistsHeading = useId()
  return (
    <nav
      aria-label="Main"
      className="fixed top-[var(--safe-top)] bottom-[calc(var(--spacing-player)+var(--safe-bottom))] left-[var(--safe-left)] z-20 hidden w-rail flex-col border-r border-border bg-surface md:flex lg:w-sidebar"
    >
      {/* px-3 on tablets: the 72px rail then fits the 44px link. In an installed window with
          Window Controls Overlay, this row is part of the title bar (titlebar-* in index.css). */}
      <div className="titlebar-drag titlebar-logo flex h-topbar shrink-0 items-center px-3 max-lg:justify-center lg:px-6">
        <Link
          to="/"
          aria-label="FXM home"
          className="flex h-touch shrink-0 items-center gap-2.5 rounded-md max-lg:w-touch max-lg:justify-center"
        >
          <LogoMark className="size-9" />
          <Wordmark className="hidden lg:inline" />
        </Link>
      </div>

      <ul className="space-y-1 px-3">
        {PRIMARY_NAV.map((item) => (
          <li key={item.to}>
            <SidebarLink item={item} />
          </li>
        ))}
      </ul>

      <div className="mx-4 my-4 border-t border-border lg:mx-6" />

      <section aria-labelledby={playlistsHeading} className="flex min-h-0 flex-1 flex-col">
        <h2
          id={playlistsHeading}
          className="sr-only lg:not-sr-only lg:px-6 lg:pb-2 lg:text-xs lg:font-bold lg:tracking-[0.12em] lg:text-text-muted lg:uppercase"
        >
          Your playlists
        </h2>
        {/* pt-1: the scroll box clips, so leave room for the first row's focus ring. */}
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pt-1 pb-4 scrollbar-thin">
          {PLACEHOLDER_PLAYLISTS.map((playlist) => (
            <li key={playlist.id}>
              <NavLink
                to={`/playlist/${playlist.id}`}
                title={playlist.name}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md p-2 transition-colors max-lg:justify-center',
                    isActive ? 'bg-elevated' : 'hover:bg-text/6',
                  )
                }
              >
                <Artwork
                  seed={`playlist:${playlist.id}`}
                  icon={playlist.icon}
                  rounded="sm"
                  className="size-10"
                />
                <span className="sr-only min-w-0 lg:not-sr-only">
                  <span className="block truncate text-sm font-semibold">{playlist.name}</span>
                  <span className="block truncate text-xs text-text-muted">Playlist</span>
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  )
}
