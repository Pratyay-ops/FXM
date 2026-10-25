import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { windowControlsOverlay } from './window-controls-overlay'

/** Chromium's `navigator.windowControlsOverlay` in an installed window, switchable by the user. */
class FakeOverlay extends EventTarget {
  constructor(public visible: boolean) {
    super()
  }

  getTitlebarAreaRect(): DOMRect {
    return new DOMRect(0, 0, 1000, this.visible ? 33 : 0)
  }

  /** The user toggles the overlay from the window's title bar. */
  toggle(visible: boolean): void {
    this.visible = visible
    this.dispatchEvent(new Event('geometrychange'))
  }
}

function installedWindow(visible: boolean): FakeOverlay {
  const overlay = new FakeOverlay(visible)
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true })
  return overlay
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'windowControlsOverlay')
})

const titleBar = () => document.querySelector<HTMLElement>('.titlebar')

describe('title bar (Window Controls Overlay)', () => {
  it('is not there in a browser tab', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(windowControlsOverlay()).toBeUndefined()
    expect(titleBar()).not.toBeInTheDocument()
    expect(document.documentElement.dataset.titlebar).toBeUndefined()
  })

  it('draws the title bar of an installed window and moves the shell below it', async () => {
    installedWindow(true)
    renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(titleBar()).toHaveTextContent('Library · FXM')
    expect(titleBar()).toHaveAttribute('aria-hidden', 'true')
    expect(document.documentElement.dataset.titlebar).toBe('overlay')
  })

  it('follows the user switching the overlay off and on', async () => {
    const overlay = installedWindow(false)
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(titleBar()).not.toBeInTheDocument()

    act(() => overlay.toggle(true))
    expect(titleBar()).toHaveTextContent('FXM')
    expect(document.documentElement.dataset.titlebar).toBe('overlay')

    act(() => overlay.toggle(false))
    expect(titleBar()).not.toBeInTheDocument()
    expect(document.documentElement.dataset.titlebar).toBeUndefined()
  })
})
