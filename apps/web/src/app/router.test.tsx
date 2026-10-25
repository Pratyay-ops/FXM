import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './app'
import { createAppRouter } from './router'

// These tests use the real browser router on happy-dom's window.history (the other
// tests use memory routers), so they cover what only the browser history does. Note
// that router.state.location includes the basename; useLocation() strips it.

let router: ReturnType<typeof createAppRouter> | undefined

afterEach(() => {
  router?.dispose()
  router = undefined
})

/** Renders the app at `url` with the browser router, as main.tsx does in production. */
function renderAtUrl(url: string, basename = '/app/') {
  window.history.replaceState(null, '', url)
  router = createAppRouter(basename)
  const user = userEvent.setup()
  render(<App router={router} />)
  return { user, router }
}

const sidebar = () => within(screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement)
const backButton = () => screen.getByRole('button', { name: 'Go back' })
const forwardButton = () => screen.getByRole('button', { name: 'Go forward' })

describe('browser router', () => {
  it('keeps the trailing slash of the /app/ base on links to Home', async () => {
    const { user } = renderAtUrl('/app/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(sidebar().getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/app/')
    expect(sidebar().getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/app/search')

    await user.click(sidebar().getByRole('link', { name: 'Home' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)$/ }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/app/')
  })

  it('opens Home for the base URL without its trailing slash', async () => {
    const { router } = renderAtUrl('/app?from=link#top')
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)$/ }),
    ).toBeInTheDocument()
    expect(router.state.location).toMatchObject({
      pathname: '/app/',
      search: '?from=link',
      hash: '#top',
    })
    expect(window.location.pathname).toBe('/app/')
  })

  it('moves focus to the page with the skip link without adding a history entry', async () => {
    const { user, router } = renderAtUrl('/app/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    const state = window.history.state

    await user.click(screen.getByRole('link', { name: 'Skip to content' }))

    expect(screen.getByRole('main')).toHaveFocus()
    expect(window.location.pathname + window.location.hash).toBe('/app/library')
    expect(window.history.state).toBe(state)
    expect(router.state.location).toMatchObject({ pathname: '/app/library', hash: '' })
  })

  it('enables back and forward like a browser does', async () => {
    const { user } = renderAtUrl('/app/')
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    expect(backButton()).toBeDisabled()
    expect(forwardButton()).toBeDisabled()

    // Push: back to Home is possible, nothing is ahead.
    await user.click(sidebar().getByRole('link', { name: 'Library' }))
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    expect(backButton()).toBeEnabled()
    expect(forwardButton()).toBeDisabled()

    // Back: at the first entry, Library is ahead.
    await user.click(backButton())
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    expect(backButton()).toBeDisabled()
    expect(forwardButton()).toBeEnabled()

    // Forward: back at Library.
    await user.click(forwardButton())
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    expect(backButton()).toBeEnabled()
    expect(forwardButton()).toBeDisabled()

    // A push after going back drops the entries ahead (Library), as in a browser.
    await user.click(backButton())
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    await user.click(sidebar().getByRole('link', { name: 'Search' }))
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    expect(backButton()).toBeEnabled()
    expect(forwardButton()).toBeDisabled()

    await user.click(backButton())
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    await user.click(forwardButton())
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument()
  })
})
