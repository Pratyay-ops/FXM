import { describe, expect, it } from 'vitest'
import { applyEmbedTheme } from './theme'

/** A media query list a test can flip. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const list = {
    matches,
    addEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  }
  return {
    matchMedia: () => list as unknown as MediaQueryList,
    flip(next: boolean) {
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent)
    },
    listeners,
  }
}

describe('applyEmbedTheme', () => {
  it('applies a light or dark theme', () => {
    const root = document.createElement('html')
    applyEmbedTheme('light', { root })
    expect(root.dataset.theme).toBe('light')
    applyEmbedTheme('dark', { root })
    expect(root.dataset.theme).toBeUndefined()
  })

  it('follows the system setting in auto, until stopped', () => {
    const root = document.createElement('html')
    const media = fakeMedia(true)
    const stop = applyEmbedTheme('auto', { root, matchMedia: media.matchMedia })
    expect(root.dataset.theme).toBe('light')

    media.flip(false)
    expect(root.dataset.theme).toBeUndefined()
    media.flip(true)
    expect(root.dataset.theme).toBe('light')

    stop()
    expect(media.listeners.size).toBe(0)
  })

  it('stays dark in auto where the browser has no media queries', () => {
    const root = document.createElement('html')
    applyEmbedTheme('auto', { root })
    expect(root.dataset.theme).toBeUndefined()
  })
})
