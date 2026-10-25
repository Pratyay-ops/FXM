import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { usePwaStore } from './pwa-store'

const toastText = /A new version of FXM is ready/

function newVersionWaits() {
  const applyUpdate = vi.fn(async () => {})
  act(() => usePwaStore.setState({ updateReady: true, applyUpdate }))
  return applyUpdate
}

describe('update toast', () => {
  it('stays hidden while there is nothing new', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText(toastText)).not.toBeInTheDocument()
  })

  it('announces a waiting version and reloads into it on request', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    const applyUpdate = newVersionWaits()

    // In a live region, which screen readers announce.
    expect(screen.getByText(toastText).closest('[aria-live="polite"]')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reload' }))

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

  it('follows the reader across pages', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    newVersionWaits()

    await user.click(screen.getAllByRole('link', { name: 'Library' })[0] as HTMLElement)
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(screen.getByText(toastText)).toBeInTheDocument()
  })
})
