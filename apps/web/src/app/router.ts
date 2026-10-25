import { createBrowserRouter } from 'react-router'
import { routes } from './routes'

/**
 * '/app' (no trailing slash) lies outside the '/app/' basename and would match no
 * route. Vite answers it with a 404 before the app loads, but a host that serves
 * the app there gets Home instead of an error.
 */
function addTrailingSlashToBase(basename: string) {
  const { pathname, search, hash } = window.location
  if (basename.endsWith('/') && pathname === basename.slice(0, -1)) {
    window.history.replaceState(window.history.state, '', `${basename}${search}${hash}`)
  }
}

/**
 * The browser router, rooted at import.meta.env.BASE_URL (vite.config.ts `base`).
 * Pass the base unchanged: React Router links the root route to the raw basename,
 * so '/app/' keeps Home at /app/, the URL that Vite (and later the service worker
 * scope) serves. Trimming it to '/app' would send every Home link to a 404.
 */
export function createAppRouter(basename: string = import.meta.env.BASE_URL) {
  addTrailingSlashToBase(basename)
  return createBrowserRouter(routes, { basename })
}
