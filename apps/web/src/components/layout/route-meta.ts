import { APP_NAME, type Track } from '@fxm/core'
import { useEffect } from 'react'
import { useMatches } from 'react-router'

/** What every route declares in its `handle` (see app/routes.tsx). */
export interface RouteHandle {
  /** Page name, used for the document title and the phone top bar. */
  title: string
  /** Top-level tab (Home, Search, Library): the phone top bar shows the logo, not "back". */
  tab?: boolean
}

function isRouteHandle(value: unknown): value is RouteHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}

/** The handle of the deepest matched route that has one. */
export function useRouteHandle(): RouteHandle | undefined {
  const matches = useMatches()
  for (let index = matches.length - 1; index >= 0; index--) {
    const handle = matches[index]?.handle
    if (isRouteHandle(handle)) return handle
  }
  return undefined
}

/**
 * Keeps the browser tab title in step with the route and the current track. A selected track
 * takes precedence while it remains in the queue; clearing the queue restores the route title.
 */
export function useDocumentTitle(handle: RouteHandle | undefined, track?: Track) {
  const title = handle?.title
  const trackTitle = track?.title
  const artists = track?.artists.map((artist) => artist.name).filter(Boolean).join(', ')
  const nowPlayingTitle = trackTitle
    ? [trackTitle, artists].filter(Boolean).join(' — ')
    : undefined

  useEffect(() => {
    document.title = nowPlayingTitle
      ? `${nowPlayingTitle} · ${APP_NAME}`
      : !title || title === 'Home'
        ? APP_NAME
        : `${title} · ${APP_NAME}`
  }, [title, nowPlayingTitle])
}
