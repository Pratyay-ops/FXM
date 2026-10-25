import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, type RouteObject } from 'react-router'
import { App } from '../app/app'
import { routes as appRoutes } from '../app/routes'

/** Renders the whole app (providers, shell, pages) at `path` with a memory router. */
export function renderApp(path = '/', routes: RouteObject[] = appRoutes) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const user = userEvent.setup()
  return { user, router, ...render(<App router={router} />) }
}
