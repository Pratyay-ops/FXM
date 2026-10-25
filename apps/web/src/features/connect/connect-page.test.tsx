import { CONNECT_SEEN_KEY, memoryStorage } from '@fxm/platform'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { resetConnection } from './connection'
import {
  CONNECT_STATUS,
  closeTestPages,
  openTestPlatform,
  setConnection,
  TIER_CAPABILITIES,
} from './testing'

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0'

function asBrowser(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
}

afterEach(async () => {
  resetConnection()
  await closeTestPages()
})

async function openPage() {
  const view = renderApp('/connect')
  // The first visit loads the page's code, which can take a while on a busy machine.
  await screen.findByRole('heading', { level: 1, name: 'FXM Connect' }, { timeout: 15_000 })
  return view
}

const status = () => screen.getByRole('status')
const tierCards = () => within(screen.getByRole('region', { name: 'What works where' }))
const guides = () => screen.getByRole('region', { name: /Get everything|Other browsers and apps/ })
const guideSummaries = () =>
  within(guides())
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent)

describe('the onboarding page', { timeout: 30_000 }, () => {
  it('says it is checking while detection runs', async () => {
    setConnection({ phase: 'detecting' })
    await openPage()
    expect(within(status()).getByText('Checking…')).toBeInTheDocument()
    expect(tierCards().queryByText('This browser')).not.toBeInTheDocument()
  })

  it('in Free only: names the tier and why, and lists what Lite and Full add', async () => {
    asBrowser(CHROME_WINDOWS)
    setConnection({ capabilities: TIER_CAPABILITIES.free, lite: 'failed' })
    await openPage()

    expect(within(status()).getByText('Free only')).toBeInTheDocument()
    expect(within(status()).getByText(/isn't installed in this browser/)).toBeInTheDocument()
    expect(within(status()).getByText(/Lite's check didn't pass/)).toBeInTheDocument()
    const current = tierCards().getByRole('listitem', { current: true })
    expect(within(current).getByRole('heading', { name: 'Free only' })).toBeInTheDocument()
    expect(within(current).getByText('This browser')).toBeInTheDocument()

    const missing = within(screen.getByRole('region', { name: "What you're missing" }))
    expect(missing.getByText(/With Lite \(experimental\)/)).toBeInTheDocument()
    expect(missing.getByText(/Its check didn't pass in this browser/)).toBeInTheDocument()
    expect(missing.getByText(/YouTube Music: search, albums/)).toBeInTheDocument()
    expect(missing.getByText(/Spotify search and related artists/)).toBeInTheDocument()
    expect(missing.getAllByText('Coming soon').length).toBeGreaterThan(0)
  })

  it('in Lite: marks it experimental, and lists only what Full adds', async () => {
    setConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })
    await openPage()

    expect(within(status()).getByText('Lite')).toBeInTheDocument()
    expect(within(status()).getByText('Experimental')).toBeInTheDocument()
    const current = tierCards().getByRole('listitem', { current: true })
    expect(within(current).getByRole('heading', { name: /Lite/ })).toBeInTheDocument()
    expect(within(current).getByText(/may stop working at any time/)).toBeInTheDocument()

    const missing = within(screen.getByRole('region', { name: "What you're missing" }))
    expect(missing.queryByText(/With Lite/)).not.toBeInTheDocument()
    expect(missing.getByText(/doesn't depend on Lite's experimental route/)).toBeInTheDocument()
  })

  it('in Full: nothing is missing, and the guides are for other browsers', async () => {
    setConnection({
      connect: CONNECT_STATUS.present,
      capabilities: TIER_CAPABILITIES.full,
      lite: 'not-needed',
    })
    await openPage()

    expect(within(status()).getByText('Full')).toBeInTheDocument()
    expect(
      within(status()).getByText('FXM Connect 0.1.0 is on in this browser.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/this device has everything FXM offers/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Other browsers and apps' })).toBeVisible()
    for (const details of guides().querySelectorAll('details')) expect(details.open).toBe(false)
  })

  it('leads with the Chromium guide in Chrome: Developer mode stays on, updates are manual', async () => {
    asBrowser(CHROME_WINDOWS)
    setConnection()
    await openPage()

    expect(guideSummaries()[0]).toMatch(/Chrome, Edge, Brave/)
    const chromium = guides().querySelector('details')
    expect(chromium?.open).toBe(true)
    const steps = within(chromium as HTMLElement)
    expect(steps.getByText('chrome://extensions')).toBeInTheDocument()
    expect(steps.getByText(/Leave Developer mode on/)).toBeInTheDocument()
    expect(steps.getByText(/Updates are manual/)).toBeInTheDocument()
    expect(steps.getByText(/managed by an employer or a school/)).toBeInTheDocument()
    expect(steps.getByRole('link', { name: /latest release on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/Pratyay-ops/FXM/releases/latest',
    )
  })

  it('leads with the temporary add-on steps in Firefox', async () => {
    asBrowser(FIREFOX)
    setConnection()
    await openPage()
    expect(guideSummaries()[0]).toBe('Firefox')
    const firefox = within(guides().querySelector('details') as HTMLElement)
    expect(firefox.getByText(/Load Temporary Add-on/)).toBeInTheDocument()
    expect(firefox.getByText(/removes temporary add-ons when it restarts/)).toBeInTheDocument()
  })

  it('leads with the Android app on Android, marked as coming soon', async () => {
    asBrowser(ANDROID_CHROME)
    setConnection()
    await openPage()
    expect(guideSummaries()[0]).toBe('Android app')
    const android = within(guides().querySelector('details') as HTMLElement)
    expect(android.getByText('Coming soon')).toBeInTheDocument()
    expect(android.getByText(/Chrome on Android can't add extensions/)).toBeInTheDocument()
  })

  it('tells Safari, iPhone and iPad what works there, Lite unverified', async () => {
    setConnection()
    await openPage()
    const apple = screen.getByRole('heading', { level: 3, name: 'Safari, iPhone and iPad' })
    const details = apple.closest('details') as HTMLElement
    expect(within(details).getByText(/hasn't been tested in Safari yet/)).toBeInTheDocument()
  })

  it("copies a browser address the page can't link to", async () => {
    asBrowser(CHROME_WINDOWS)
    setConnection()
    // user-event puts its own clipboard in place of the browser's.
    const { user } = await openPage()
    await user.click(
      screen.getAllByRole('button', { name: 'Copy chrome://extensions' })[0] as HTMLElement,
    )
    expect(await navigator.clipboard.readText()).toBe('chrome://extensions')
    expect(await screen.findByRole('button', { name: 'Copied chrome://extensions' })).toBeVisible()
  })

  it('leads with the update steps when FXM Connect is outdated', async () => {
    asBrowser(CHROME_WINDOWS)
    setConnection({ connect: CONNECT_STATUS.outdated })
    await openPage()
    const update = within(screen.getByRole('region', { name: 'Update FXM Connect' }))
    expect(update.getByText(/0\.0\.9 is too old for this version of FXM/)).toBeInTheDocument()
    expect(update.getByText(/Install version 0\.1\.0 or later/)).toBeInTheDocument()
    expect(update.getByText(/unzip it over the folder/)).toBeInTheDocument()
    expect(update.getByText('chrome://extensions')).toBeInTheDocument()
  })

  it('points a missing FXM Connect to the apps, and forgets it on request', async () => {
    asBrowser(CHROME_WINDOWS)
    const storage = memoryStorage()
    storage.setItem(CONNECT_SEEN_KEY, JSON.stringify({ version: '0.1.0', at: 1 }))
    await openTestPlatform({ storage })
    const { user } = await openPage()

    const missing = screen.getByRole('region', { name: "FXM Connect isn't answering" })
    expect(
      within(missing).getByText(/worked in this browser before \(version 0\.1\.0\)/),
    ).toBeVisible()
    expect(within(missing).getByText(/turns it off whenever Developer mode is off/)).toBeVisible()

    await user.click(within(missing).getByRole('button', { name: 'Desktop app' }))
    const desktop = screen
      .getByRole('heading', { level: 3, name: 'Desktop app' })
      .closest('details')
    expect(desktop?.open).toBe(true)

    await user.click(within(missing).getByRole('button', { name: 'I removed it on purpose' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: "FXM Connect isn't answering" }),
      ).not.toBeInTheDocument(),
    )
  })

  it('in the desktop app: no extension guides', async () => {
    setConnection({
      platform: 'desktop',
      environment: 'tauri',
      capabilities: TIER_CAPABILITIES.full,
    })
    await openPage()
    expect(within(status()).getByText('This app')).toBeInTheDocument()
    expect(within(status()).getByText(/desktop app reaches every service directly/)).toBeVisible()
    expect(screen.queryByRole('region', { name: /Get everything|Other browsers/ })).toBeNull()
  })
})
