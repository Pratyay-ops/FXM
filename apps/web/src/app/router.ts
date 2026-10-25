import { createBrowserRouter } from 'react-router'
import { routes } from './routes'

/** React Router basename for Vite's base URL: '/app/' becomes '/app', so /app matches too. */
export function routerBasename(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** The browser router, rooted at import.meta.env.BASE_URL (vite.config.ts `base`). */
export function createAppRouter() {
  return createBrowserRouter(routes, { basename: routerBasename(import.meta.env.BASE_URL) })
}
