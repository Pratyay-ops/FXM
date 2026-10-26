import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { TOAST_SPACE_PROPERTY } from '../pwa/update-toast'
import { type AppUpdateState, useAppUpdateStore } from './app-update-store'
import { AppUpdateToast, offeredVersion } from './app-update-toast'
import { FIRST_CHECK_DELAY_MS } from './checks'
import { apkDownloadUrl, LATEST_RELEASE_URL } from './releases'
import type { AppUpdateSupport } from './support'
import { jsonResponse, releaseAnswer, testAppUpdateStore } from './testing'

const ANDROID: AppUpdateSupport = { checks: true, version: '0.5.0' }
const toast = () => screen.getByRole('region', { name: 'App update' })
const toastSpace = () => document.documentElement.style.getPropertyValue(TOAST_SPACE_PROPERTY)

function storeWith(state: Partial<AppUpdateState>) {
  const store = testAppUpdateStore()
  store.setState(state)
  return store
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAppUpdateStore.setState(useAppUpdateStore.getInitialState(), true)
})

describe('offeredVersion', () => {
  const initial = testAppUpdateStore().getState()
  const found = (version: string, hasApk = true): AppUpdateState => ({
    ...initial,
    latest: { version, hasApk },
  })

  it('offers a newer release that has its APK, until the user answers', () => {
    expect(offeredVersion(found('0.6.0'), '0.5.0')).toBe('0.6.0')
    expect(
      offeredVersion({ ...found('0.6.0'), dismissedVersion: '0.6.0' }, '0.5.0'),
    ).toBeUndefined()
    // A newer one comes back, whatever the user said to the last.
    expect(offeredVersion({ ...found('0.6.1'), dismissedVersion: '0.6.0' }, '0.5.0')).toBe('0.6.1')
  })

  it('offers nothing older or equal, and no release without its APK', () => {
    expect(offeredVersion(found('0.5.0'), '0.5.0')).toBeUndefined()
    expect(offeredVersion(found('0.4.0'), '0.5.0')).toBeUndefined()
    expect(offeredVersion(found('0.6.0', false), '0.5.0')).toBeUndefined()
  })
})

describe('AppUpdateToast', () => {
  it('offers a new version in a landmark, with a link to its APK', () => {
    const store = storeWith({ latest: { version: '0.6.0', hasApk: true } })
    render(<AppUpdateToast support={ANDROID} store={store} />)
    expect(toast()).toHaveTextContent('FXM 0.6.0 is out.')
    expect(toast().closest('[aria-live="polite"]')).toBeInTheDocument()
    const download = within(toast()).getByRole('link', { name: 'Download FXM 0.6.0' })
    // The app opens it in the browser, which downloads it; nothing downloads in the app.
    expect(download).toHaveAttribute('href', apkDownloadUrl('0.6.0'))
    expect(download).toHaveAttribute('target', '_blank')
    expect(download).toHaveAttribute('rel', 'noreferrer')
    // Like the web app's update toast, it keeps room for the app's confirmations.
    expect(toastSpace()).not.toBe('')
  })

  it('shows nothing while there is nothing new, or in builds that don’t check', () => {
    const store = storeWith({ latest: { version: '0.5.0', hasApk: true } })
    const { unmount } = render(<AppUpdateToast support={ANDROID} store={store} />)
    expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()
    unmount()
    store.setState({ latest: { version: '0.6.0', hasApk: true } })
    for (const reason of ['not-android', 'fdroid', 'unreleased'] as const) {
      const view = render(<AppUpdateToast support={{ checks: false, reason }} store={store} />)
      expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()
      view.unmount()
    }
  })

  it('goes away with "Not now" until a newer version is out, handing focus back', async () => {
    const user = userEvent.setup()
    const store = storeWith({ latest: { version: '0.6.0', hasApk: true } })
    render(
      <>
        <button type="button">Elsewhere</button>
        <AppUpdateToast support={ANDROID} store={store} />
      </>,
    )
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    await user.tab()
    expect(within(toast()).getByRole('button', { name: 'Not now' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()
    expect(store.getState().dismissedVersion).toBe('0.6.0')
    expect(elsewhere).toHaveFocus()
    expect(toastSpace()).toBe('')

    act(() => store.setState({ latest: { version: '0.6.1', hasApk: true } }))
    expect(toast()).toHaveTextContent('FXM 0.6.1 is out.')
  })

  it('goes away with Escape, and once the user chose Download', async () => {
    const user = userEvent.setup()
    const store = storeWith({ latest: { version: '0.6.0', hasApk: true } })
    render(<AppUpdateToast support={ANDROID} store={store} />)
    within(toast()).getByRole('button', { name: 'Not now' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()

    act(() => store.setState({ latest: { version: '0.6.1', hasApk: true } }))
    // happy-dom opens nothing for a link with target="_blank".
    await user.click(within(toast()).getByRole('link', { name: 'Download FXM 0.6.1' }))
    expect(screen.queryByRole('region', { name: 'App update' })).not.toBeInTheDocument()
    expect(store.getState().dismissedVersion).toBe('0.6.1')
  })

  it('checks GitHub a while after start-up, without cookies or a Referer, and offers what it found', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => jsonResponse(releaseAnswer('0.6.0')))
    vi.stubGlobal('fetch', fetch)
    const store = testAppUpdateStore()
    render(<AppUpdateToast support={ANDROID} store={store} />)
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS))
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(LATEST_RELEASE_URL, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    })
    expect(toast()).toHaveTextContent('FXM 0.6.0 is out.')
  })

  it('stays out of the web app, whatever was stored', async () => {
    useAppUpdateStore.setState({ latest: { version: '99.0.0', hasApk: true } })
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText(/FXM 99.0.0 is out/)).not.toBeInTheDocument()
  })
})
