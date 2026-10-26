import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import * as notices from './notices'
import {
  BUNDLED_NOTICES_FILE,
  BUNDLED_NOTICES_TITLE,
  fetchBundledNotices,
  NOTICES_ROUTE,
  showsBundledNotices,
} from './notices'

const NOTICES = `${BUNDLED_NOTICES_TITLE}

==============================================================================
androidx.media3:media3-exoplayer 1.11.1 (Media3 ExoPlayer module)
Licence: Apache-2.0
`

/** The Android app's build (base `/`), serving `files` from its web folder and 404 otherwise. */
function androidBuild(files: Record<string, string>) {
  vi.stubEnv('BASE_URL', '/')
  vi.spyOn(notices, 'showsBundledNotices').mockReturnValue(true)
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    const body = files[path]
    return body === undefined
      ? new Response('<!doctype html><title>FXM</title>', { status: 404 })
      : new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('showsBundledNotices', () => {
  it('is the Android app only: the web and desktop apps link the website’s notices', () => {
    expect(showsBundledNotices('capacitor')).toBe(true)
    expect(showsBundledNotices('browser')).toBe(false)
    expect(showsBundledNotices('tauri')).toBe(false)
    expect(showsBundledNotices(undefined)).toBe(false)
  })

  it('is off in the test browser', () => {
    expect(showsBundledNotices()).toBe(false)
  })
})

describe('fetchBundledNotices', () => {
  it('reads the file from the app’s own folder, never a cached copy', async () => {
    const fetch = vi.fn(async () => new Response(NOTICES))
    expect(await fetchBundledNotices(fetch, '/')).toBe(NOTICES)
    expect(fetch).toHaveBeenCalledWith(`/${BUNDLED_NOTICES_FILE}`, { cache: 'no-store' })
  })

  it('rejects when the build has no notices', async () => {
    const missing = vi.fn(async () => new Response('', { status: 404 }))
    await expect(fetchBundledNotices(missing, '/')).rejects.toThrow('HTTP 404')
  })

  it('rejects the app’s page, which a server may send for any path', async () => {
    const page = vi.fn(async () => new Response('<!doctype html><title>FXM</title>'))
    await expect(fetchBundledNotices(page, '/')).rejects.toThrow('No third-party notices')
  })
})

describe('Settings → About → Third-party notices', () => {
  it('opens the notices the APK carries in the Android app, without leaving it', async () => {
    const fetch = androidBuild({ [`/${BUNDLED_NOTICES_FILE}`]: NOTICES })
    const { user, router } = renderApp('/settings')
    const about = await screen.findByRole('region', { name: 'About' })
    const legal = within(about).getByRole('list', { name: 'Legal' })
    const link = within(legal).getByRole('link', { name: 'Third-party notices' })
    expect(link).toHaveAttribute('href', NOTICES_ROUTE)
    expect(link).not.toHaveAttribute('target')
    // The privacy page and the disclaimer stay on the website.
    expect(within(legal).getByRole('link', { name: /^Privacy/ })).toHaveAttribute(
      'href',
      'https://fxmusic.pages.dev/privacy',
    )

    await user.click(link)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Third-party notices' }),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(NOTICES_ROUTE)
    expect(await screen.findByText(/androidx\.media3:media3-exoplayer 1\.11\.1/)).toBeVisible()
    expect(fetch).toHaveBeenCalledWith(`/${BUNDLED_NOTICES_FILE}`, { cache: 'no-store' })
  })

  it('says so when the build carries none, and points to the website’s', async () => {
    androidBuild({})
    renderApp(NOTICES_ROUTE)
    expect(await screen.findByText(/This build of FXM carries no notices file/)).toBeVisible()
    expect(screen.getByRole('link', { name: /The web app's notices/ })).toHaveAttribute(
      'href',
      'https://fxmusic.pages.dev/third-party-notices.txt',
    )
  })

  it('titles the page', async () => {
    androidBuild({ [`/${BUNDLED_NOTICES_FILE}`]: NOTICES })
    renderApp(NOTICES_ROUTE)
    await screen.findByText(/androidx\.media3:media3-exoplayer/)
    expect(document.title).toBe('Third-party notices · FXM')
  })
})
