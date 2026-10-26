import { act, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { showFeedback } from '../search/feedback'
import { usePwaStore } from './pwa-store'
import { PHONE_QUERY, TOAST_SPACE_PROPERTY } from './update-toast'

const toastText = /A new version of FXM is ready/

function newVersionWaits() {
  const applyUpdate = vi.fn(async () => {})
  act(() => usePwaStore.setState({ updateReady: true, applyUpdate }))
  return applyUpdate
}

const toast = () => screen.getByRole('region', { name: 'App update' })

/** The room the toast keeps on <html> for the app's confirmations, which rise above it. */
const toastSpace = () => document.documentElement.style.getPropertyValue(TOAST_SPACE_PROPERTY)

/** Makes `matchMedia` report a phone's window, below 768px. */
function onAPhone() {
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const list = matchMedia(query)
    // `matches` is a getter on the prototype: shadow it on this list.
    if (query === PHONE_QUERY) Object.defineProperty(list, 'matches', { value: true })
    return list
  })
}

describe('update toast', () => {
  it('stays hidden while there is nothing new', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText(toastText)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()
  })

  it('announces a waiting version in a landmark, and reloads into it on request', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const applyUpdate = newVersionWaits()

    // In a live region, which screen readers announce, and a landmark they can jump to.
    expect(toast().closest('[aria-live="polite"]')).toBeInTheDocument()
    expect(toast()).toHaveTextContent(toastText)

    await user.click(within(toast()).getByRole('button', { name: 'Reload' }))

    expect(applyUpdate).toHaveBeenCalledOnce()
  })

  it('goes away for now with "Not now"', async () => {
    const { user } = renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })
    const applyUpdate = newVersionWaits()

    await user.click(screen.getByRole('button', { name: 'Not now' }))

    expect(screen.queryByText(toastText)).not.toBeInTheDocument()
    expect(applyUpdate).not.toHaveBeenCalled()
    expect(usePwaStore.getState().updateDismissed).toBe(true)
  })

  it('hands focus back to where it came from', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    newVersionWaits()
    const settings = within(screen.getByRole('banner')).getByRole('link', { name: 'Settings' })
    settings.focus()

    // From Settings into the toast, then "Not now".
    within(toast()).getByRole('button', { name: 'Not now' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByText(toastText)).not.toBeInTheDocument()
    expect(settings).toHaveFocus()
  })

  it('goes away with Escape, focus moving to the page when it came from nowhere', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const applyUpdate = newVersionWaits()

    within(toast()).getByRole('button', { name: 'Reload' }).focus()
    await user.keyboard('{Escape}')

    expect(screen.queryByText(toastText)).not.toBeInTheDocument()
    expect(applyUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('follows the reader across pages', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    newVersionWaits()

    await user.click(screen.getAllByRole('link', { name: 'Library' })[0] as HTMLElement)
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(screen.getByText(toastText)).toBeInTheDocument()
  })

  it("moves to the top on a phone's Now Playing, clear of its big controls", async () => {
    renderApp('/now-playing')
    await screen.findByRole('heading', { level: 1, name: 'Now playing' })
    newVersionWaits()

    // Placement is CSS; e2e/pwa.spec.ts checks the boxes at 320 px.
    const region = toast().parentElement
    expect(region?.className).toMatch(/max-md:top-\[calc\(var\(--shell-top\)/)
    expect(region?.className).toMatch(/max-md:bottom-auto/)
  })

  it("keeps the app's confirmations above it, not over it", async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(64)
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    newVersionWaits()
    act(() => showFeedback('Added to queue'))

    // The confirmation toast rises by the room the update toast keeps: its height and a gap.
    // Placement is CSS; e2e/pwa.spec.ts checks the boxes.
    expect(toastSpace()).toBe('calc(64px + 0.5rem)')
    const confirmation = screen.getByText('Added to queue').closest('[role="status"]')
    expect(confirmation?.className).toContain(`var(${TOAST_SPACE_PROPERTY},0px)`)

    await user.click(screen.getByRole('button', { name: 'Not now' }))

    expect(toastSpace()).toBe('')
  })

  it("keeps no room on a phone's Now Playing, where it sits at the top", async () => {
    onAPhone()
    renderApp('/now-playing')
    await screen.findByRole('heading', { level: 1, name: 'Now playing' })
    newVersionWaits()

    expect(toast()).toHaveTextContent(toastText)
    expect(toastSpace()).toBe('')
  })
})
