import { lazy, Suspense } from 'react'
import { Link, NavLink } from 'react-router'
import { cn } from '../../lib/cn'
import { LogoMark, Wordmark } from '../ui/logo'
import { type NavItem, PRIMARY_NAV } from './nav-items'

// The library's playlists (stage 2.6) load after the shell's first render, not with it: they
// bring the library database and drag and drop, and phones don't show the sidebar at all.
const SidebarPlaylists = lazy(() =>
  import('../../features/library/sidebar-playlists').then((module) => ({
    default: module.SidebarPlaylists,
  })),
)

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

      {/* The library's playlists in their saved order, reorderable right here (stage 2.6). */}
      <Suspense fallback={<div className="min-h-0 flex-1" />}>
        <SidebarPlaylists />
      </Suspense>
    </nav>
  )
}
