import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { AppUpdateSetting, INSTALL_GUIDE_URL } from './app-update-setting'
import type { AppUpdateState } from './app-update-store'
import { apkDownloadUrl, releasePageUrl } from './releases'
import type { AppUpdateSupport } from './support'
import { testAppUpdateStore } from './testing'

const ANDROID: AppUpdateSupport = { checks: true, version: '0.5.0' }
const NOW = Date.UTC(2026, 10, 2, 10, 0, 0)

function setting(
  state: Partial<AppUpdateState>,
  support: AppUpdateSupport = ANDROID,
  check = vi.fn(async () => {}),
) {
  const store = testAppUpdateStore()
  store.setState(state)
  const view = render(
    <AppUpdateSetting support={support} store={store} now={() => NOW} check={check} />,
  )
  return { ...view, store, check }
}

describe('AppUpdateSetting', () => {
  it('says what the daily check does, and that nothing installs by itself', () => {
    setting({})
    expect(screen.getByText('Updates')).toBeInTheDocument()
    expect(
      screen.getByText(/Once a day, FXM asks GitHub whether a new version is out/),
    ).toHaveTextContent(
      'It never downloads or installs anything by itself: Android asks you before it updates FXM.',
    )
    expect(screen.getByRole('link', { name: /How updates install/ })).toHaveAttribute(
      'href',
      INSTALL_GUIDE_URL,
    )
    expect(screen.getByText('Not checked yet.')).toBeInTheDocument()
  })

  it('offers a newer version’s APK and notes', () => {
    setting({ latest: { version: '0.6.0', hasApk: true }, lastCheckedAt: NOW - 60_000 })
    expect(screen.getByText('FXM 0.6.0 is out.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Download the APK/ })).toHaveAttribute(
      'href',
      apkDownloadUrl('0.6.0'),
    )
    expect(screen.getByRole('link', { name: /What's new/ })).toHaveAttribute(
      'href',
      releasePageUrl('0.6.0'),
    )
  })

  it('also after the user put the toast off, until the app is updated', () => {
    setting({ latest: { version: '0.6.0', hasApk: true }, dismissedVersion: '0.6.0' })
    expect(screen.getByRole('link', { name: /Download the APK/ })).toBeInTheDocument()
  })

  it('says when a release has no APK yet', () => {
    setting({ latest: { version: '0.6.0', hasApk: false } })
    expect(screen.getByText(/Its APK isn't there yet/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Download the APK/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /What's new/ })).toBeInTheDocument()
  })

  it('says the app is up to date, and when it last checked', () => {
    setting({ latest: { version: '0.5.0', hasApk: true }, lastCheckedAt: NOW - 2 * 3600_000 })
    expect(
      screen.getByText('You have the latest version. Checked 2 hours ago.'),
    ).toBeInTheDocument()
  })

  it.each([
    ['offline', /this device is offline/],
    ['rate-limited', /too many requests from this connection/],
    ['unreachable', /Couldn't reach GitHub/],
    ['unexpected', /didn't make sense/],
  ] as const)('explains a failed check (%s)', (problem, text) => {
    setting({ problem, lastCheckedAt: NOW - 3600_000 })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('checks on request, announcing the result', async () => {
    const user = userEvent.setup()
    const { store, check } = setting({ latest: { version: '0.5.0', hasApk: true } })
    const button = screen.getByRole('button', { name: 'Check now' })
    await user.click(button)
    expect(check).toHaveBeenCalledOnce()
    act(() => store.setState({ checking: true }))
    const status = screen.getByText('Checking…')
    expect(status.closest('[aria-live="polite"]')).toBeInTheDocument()
    // Never disabled, so focus stays on it.
    expect(button).toBeEnabled()
    act(() =>
      store.setState({
        checking: false,
        latest: { version: '0.6.0', hasApk: true },
        lastCheckedAt: NOW,
      }),
    )
    expect(screen.getByText('FXM 0.6.0 is out.')).toBeInTheDocument()
  })

  it('says that F-Droid updates F-Droid builds, with nothing to check', () => {
    setting({ latest: { version: '0.6.0', hasApk: true } }, { checks: false, reason: 'fdroid' })
    expect(screen.getByText(/F-Droid updates this app/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
    expect(screen.queryByText(/FXM 0.6.0 is out/)).not.toBeInTheDocument()
  })

  it('shows nothing in the web and desktop apps, and in development builds', () => {
    for (const reason of ['not-android', 'unreleased'] as const) {
      const { container, unmount } = setting({}, { checks: false, reason })
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('stays out of the web app’s Settings', async () => {
    renderApp('/settings')
    const about = await screen.findByRole('region', { name: 'About' })
    expect(within(about).queryByText('Updates')).not.toBeInTheDocument()
  })
})
