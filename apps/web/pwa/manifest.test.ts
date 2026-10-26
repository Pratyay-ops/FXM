// @vitest-environment node
// Build-time config: no DOM.
import { readFileSync } from 'node:fs'
import { APP_NAME } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { ICON_FILES } from './icons.ts'
import { APP_BASE, APP_TITLE, BACKGROUND_COLOR, webManifest } from './manifest.ts'

const manifest = webManifest()

describe('web app manifest', () => {
  it('names the app FXM, like @fxm/core', () => {
    expect(APP_TITLE).toBe(APP_NAME)
    expect(manifest).toMatchObject({ name: APP_NAME, short_name: APP_NAME, lang: 'en' })
    expect(manifest.description).toMatch(/music player/)
  })

  it('identifies, starts and scopes the app at /app/, where it is served', () => {
    expect(APP_BASE).toBe('/app/')
    expect(manifest).toMatchObject({ id: '/app/', start_url: '/app/', scope: '/app/' })
  })

  it('follows another base', () => {
    expect(webManifest('/beta/')).toMatchObject({
      id: '/beta/',
      start_url: '/beta/',
      scope: '/beta/',
    })
  })

  it('opens in its own window, with Window Controls Overlay on desktop', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.display_override).toEqual(['window-controls-overlay'])
  })

  it('focuses the open window on a new launch instead of starting a second player', () => {
    expect(manifest.launch_handler).toEqual({ client_mode: ['focus-existing', 'auto'] })
  })

  it('colours the splash screen and title bar like the dark theme', () => {
    const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
    const background = /--color-background:\s*(#[0-9a-f]{6})/.exec(tokens)?.[1]
    expect(BACKGROUND_COLOR).toBe(background)
    expect(manifest).toMatchObject({
      background_color: BACKGROUND_COLOR,
      theme_color: BACKGROUND_COLOR,
    })
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    expect(html).toContain(`<meta name="theme-color" content="${BACKGROUND_COLOR}" />`)
  })

  it('lists 192 and 512 px icons, plain and maskable, that the app ships', () => {
    expect(manifest.icons).toEqual([
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])
    const shipped = ICON_FILES.map((icon) => icon.file)
    for (const icon of manifest.icons ?? []) expect(shipped).toContain(icon.src)
  })

  it('offers shortcuts to pages inside the app', () => {
    expect(manifest.shortcuts?.map((shortcut) => shortcut.url)).toEqual([
      '/app/search',
      '/app/library',
    ])
  })
})
