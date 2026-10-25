import { Heart, House, LibraryBig, type LucideIcon, Search } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Only active on an exact match (Home would otherwise match every page). */
  end?: boolean
}

/** Main navigation: the desktop sidebar and the phone tab bar. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/library', label: 'Library', icon: LibraryBig },
]

export interface PlaylistLink {
  id: string
  name: string
  icon?: LucideIcon
}

/** Placeholder "Your playlists" entries until the library lands (stage 2.6). */
export const PLACEHOLDER_PLAYLISTS: readonly PlaylistLink[] = [
  { id: 'liked', name: 'Liked songs', icon: Heart },
  { id: 'chill-mix', name: 'Chill mix' },
  { id: 'focus-flow', name: 'Focus flow' },
  { id: 'workout', name: 'Workout' },
  { id: 'road-trip', name: 'Road trip' },
]
