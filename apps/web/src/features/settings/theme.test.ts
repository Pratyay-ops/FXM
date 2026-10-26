import { describe, expect, it } from 'vitest'
import indexHtml from '../../../index.html?raw'
import { SETTINGS_STORAGE_KEY } from './settings-store'
import { applyTheme, resolveTheme } from './theme'

describe('resolveTheme', () => {
  it.each([
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['light', false, 'light'],
    ['system', true, 'light'],
    ['system', false, 'dark'],
  ] as const)('shows %s (system prefers light: %s) as %s', (preference, prefersLight, expected) => {
    expect(resolveTheme(preference, prefersLight)).toBe(expected)
  })
})

describe('applyTheme', () => {
  it('sets data-theme on <html> and the browser UI color', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.append(meta)
    document.documentElement.style.setProperty('--color-background', '#f6f6f8')

    applyTheme('light')

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(meta.content).toBe('#f6f6f8')
    meta.remove()
    document.documentElement.style.removeProperty('--color-background')
  })
})

describe('index.html', () => {
  it('reads the same storage key as the settings store before the first paint', () => {
    expect(indexHtml).toContain(`localStorage.getItem('${SETTINGS_STORAGE_KEY}')`)
  })
})
