import { APP_NAME } from '@fxm/core'
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

/** The window title for a page: "Search · FXM", or just "FXM" on Home. */
export function documentTitle(title: string | undefined): string {
  return !title || title === 'Home' ? APP_NAME : `${title} · ${APP_NAME}`
}

/** Keeps `document.title` in step with the current route ("Search · FXM"). */
export function useDocumentTitle(handle: RouteHandle | undefined) {
  const title = handle?.title
  useEffect(() => {
    document.title = documentTitle(title)
  }, [title])
}
