import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { titlebarInsets, windowControlsOverlay } from './window-controls-overlay'

/** Where the window buttons are: macOS puts them on the left, everyone else on the right. */
type Side = 'left' | 'right'

/** Chromium's `navigator.windowControlsOverlay` in an installed window, switchable by the user. */
class FakeOverlay extends EventTarget {
  constructor(
    public visible: boolean,
    public side: Side = 'right',
    public buttons = 140,
  ) {
    super()
  }

  getTitlebarAreaRect(): DOMRect {
    if (!this.visible) return new DOMRect(0, 0, 0, 0)
    const x = this.side === 'left' ? this.buttons : 0
    return new DOMRect(x, 0, window.innerWidth - this.buttons, 33)
  }

  /** The user toggles the overlay from the window's title bar. */
  toggle(visible: boolean): void {
    this.visible = visible
    this.dispatchEvent(new Event('geometrychange'))
  }
}

function installedWindow(visible: boolean, side?: Side, buttons?: number): FakeOverlay {
  const overlay = new FakeOverlay(visible, side, buttons)
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true })
  return overlay
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'windowControlsOverlay')
})

const root = () => document.documentElement
const inset = (side: Side) => root().style.getPropertyValue(`--titlebar-${side}`)

describe('title bar (Window Controls Overlay)', () => {
  it('leaves a browser tab alone', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(windowControlsOverlay()).toBeUndefined()
    expect(root().dataset.titlebar).toBeUndefined()
    expect(inset('right')).toBe('')
  })

  it('makes the top bar the title bar, clear of the window buttons on the right', async () => {
    installedWindow(true, 'right', 140)
    renderApp('/library')
    await screen.findByRole('heading', { level: 1, name: 'Your library' })

    expect(root().dataset.titlebar).toBe('overlay right')
    expect(inset('right')).toBe('140px')
    expect(inset('left')).toBe('0px')
    // The top bar and the sidebar's logo row drag the window (styles/index.css).
    expect(screen.getByRole('banner')).toHaveClass('titlebar-drag')
    // No title bar of its own: the page's top bar is it.
    expect(document.querySelector('.titlebar')).not.toBeInTheDocument()
  })

  it('knows window buttons on the left, as on macOS', async () => {
    installedWindow(true, 'left', 80)
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })

    expect(root().dataset.titlebar).toBe('overlay left')
    expect(inset('left')).toBe('80px')
    expect(inset('right')).toBe('0px')
  })

  it('follows the user switching the overlay off and on', async () => {
    const overlay = installedWindow(false)
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(root().dataset.titlebar).toBeUndefined()

    act(() => overlay.toggle(true))
    expect(root().dataset.titlebar).toBe('overlay right')

    act(() => overlay.toggle(false))
    expect(root().dataset.titlebar).toBeUndefined()
    expect(inset('right')).toBe('')
  })

  it('follows the window buttons when the geometry changes', async () => {
    const overlay = installedWindow(true, 'right', 140)
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })

    act(() => {
      overlay.buttons = 96
      overlay.dispatchEvent(new Event('geometrychange'))
    })

    expect(inset('right')).toBe('96px')
  })
})

describe('titlebarInsets', () => {
  it('measures the window buttons on either side of the free title bar area', () => {
    expect(titlebarInsets(new DOMRect(0, 0, 1140, 33), 1280)).toEqual({ left: 0, right: 140 })
    expect(titlebarInsets(new DOMRect(78, 0, 1202, 28), 1280)).toEqual({ left: 78, right: 0 })
    // Rounded to whole pixels, never negative.
    expect(titlebarInsets(new DOMRect(0.4, 0, 1300, 33), 1280)).toEqual({ left: 0, right: 0 })
  })
})
