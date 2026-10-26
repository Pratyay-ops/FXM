import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { resetConnection, useConnection } from './connection'
import { useNotices } from './notices'
import {
  asBrowser,
  CONNECT_STATUS,
  closeTestPages,
  DETECTING,
  openTestPlatform,
  setConnection,
  storageWithConnectSeen,
  TIER_CAPABILITIES,
  USER_AGENTS,
} from './testing'

afterEach(async () => {
  resetConnection()
  useNotices.setState({ dismissed: [] })
  await closeTestPages()
})

async function openPage() {
  const view = renderApp('/connect')
  // The first visit loads the page's code, which can take a while on a busy machine.
  await screen.findByRole('heading', { level: 1, name: 'FXM Connect' }, { timeout: 15_000 })
  return view
}

const status = () => screen.getByRole('region', { name: /^This (browser|app)$/ })
const tierCards = () => within(screen.getByRole('region', { name: 'What works where' }))
const guides = () =>
  screen.getByRole('region', {
    name: /^(Get everything|Other browsers and apps|Other devices and apps)$/,
  })
const guideTitles = () =>
  within(guides())
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.firstElementChild?.textContent)
const firstGuide = () => guides().querySelector('details') as HTMLDetailsElement
const sectionTitles = () =>
  within(screen.getByRole('main'))
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent)

describe('the onboarding page', { timeout: 30_000 }, () => {
  it('says it is checking while detection runs', async () => {
    useConnection.setState(DETECTING, true)
    await openPage()
    expect(within(status()).getByText('Checking…')).toBeInTheDocument()
    expect(tierCards().queryByText('This browser')).not.toBeInTheDocument()
  })

  it("names the tier as soon as FXM Connect answered, while Lite's check runs", async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    useConnection.setState({ ...DETECTING, connect: CONNECT_STATUS.absent, lite: 'checking' }, true)
    await openPage()
    expect(within(status()).getByText('Free only')).toBeInTheDocument()
    expect(within(status()).getByText(/Checking whether Lite works/)).toBeInTheDocument()
    expect(
      within(status()).getByRole('button', { name: 'Add FXM Connect to Chrome' }),
    ).toBeVisible()
  })

  it('in Free only: names the tier and why, what is missing, and the install for this browser', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    setConnection({ capabilities: TIER_CAPABILITIES.free, lite: 'failed' })
    const { user } = await openPage()

    const card = within(status())
    expect(card.getByRole('heading', { level: 2, name: 'This browser' })).toBeInTheDocument()
    expect(card.getByText('Free only')).toBeInTheDocument()
    expect(card.getByText(/isn't installed in this browser/)).toBeInTheDocument()
    expect(card.getByText(/Lite's check didn't pass .* needs FXM Connect here/)).toBeInTheDocument()
    const current = tierCards().getByRole('listitem', { current: true })
    expect(within(current).getByRole('heading', { name: 'Free only' })).toBeInTheDocument()
    expect(within(current).getByText('This browser')).toBeInTheDocument()

    // A summary, not the tier cards' lists again.
    const missing = within(card.getByRole('region', { name: "What you're missing" }))
    expect(missing.getByText(/adds YouTube Music and its ad-free audio\./)).toBeInTheDocument()
    expect(
      missing.getByText(
        /adds YouTube Music without Lite's experimental route, and Spotify search and related artists\. A read-only sync of your Spotify account and downloads are coming soon\./,
      ),
    ).toBeInTheDocument()

    // The guides come before the tier cards, and the main button opens the one for Chrome.
    expect(sectionTitles()).toEqual(['This browser', 'Get everything', 'What works where'])
    const chromium = firstGuide()
    chromium.open = false
    await user.click(card.getByRole('button', { name: 'Add FXM Connect to Chrome' }))
    expect(chromium.open).toBe(true)
    expect(document.activeElement).toBe(chromium.querySelector('summary'))
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
    expect(missing.queryByText(/Lite \(experimental\)/)).not.toBeInTheDocument()
    expect(missing.getByText(/without Lite's experimental route/)).toBeInTheDocument()
  })

  it('in Full: nothing is missing, and the guides are for other browsers, after the tiers', async () => {
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
    expect(within(status()).queryByRole('button')).toBeNull()
    expect(sectionTitles()).toEqual(['This browser', 'What works where', 'Other browsers and apps'])
    for (const details of guides().querySelectorAll('details')) expect(details.open).toBe(false)
  })

  it('marks the unreleased apps as coming soon wherever it names them', async () => {
    setConnection()
    await openPage()
    const full = tierCards().getByRole('heading', { level: 3, name: 'Full' }).closest('li')
    expect(
      within(full as HTMLElement).getByText(
        'FXM Connect, the desktop app or the Android app (coming soon).',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /The desktop app needs no extension: it has everything built in\. The Android app is coming soon\./,
      ),
    ).toBeInTheDocument()
    // The Android app's guide says where to follow the release, with no steps for a file that
    // isn't there; the desktop app's has steps, and links its install steps.
    const guide = (name: RegExp) =>
      within(guides()).getByRole('heading', { level: 3, name }).closest('details') as HTMLElement
    const android = guide(/^Android app/)
    expect(within(android).getByText('Coming soon')).toBeInTheDocument()
    expect(within(android).getByText(/Not released yet/)).toBeInTheDocument()
    expect(android.querySelector('ol')).toBeNull()
    const desktop = guide(/^Desktop app/)
    expect(within(desktop).queryByText('Coming soon')).toBeNull()
    expect(desktop.querySelector('ol')).not.toBeNull()
    expect(within(desktop).getByRole('link', { name: /install steps/ })).toHaveAttribute(
      'href',
      'https://github.com/Pratyay-ops/FXM/blob/main/apps/desktop/INSTALL.md',
    )
  })

  it('leads with the Chromium guide in Chrome: Developer mode stays on, updates are manual', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    setConnection()
    await openPage()

    expect(guideTitles()[0]).toMatch(/Chrome, Edge, Brave/)
    const chromium = firstGuide()
    expect(chromium.open).toBe(true)
    const steps = within(chromium)
    expect(
      within(chromium.querySelector('summary') as HTMLElement).getByText('For this device'),
    ).toBeInTheDocument()
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
    asBrowser(USER_AGENTS.firefoxLinux)
    setConnection()
    await openPage()
    expect(guideTitles()[0]).toBe('Firefox')
    expect(
      within(status()).getByRole('button', { name: 'Add FXM Connect to Firefox' }),
    ).toBeVisible()
    const firefox = within(firstGuide())
    expect(firefox.getByText(/Load Temporary Add-on/)).toBeInTheDocument()
    expect(firefox.getByText(/removes temporary add-ons when it restarts/)).toBeInTheDocument()
  })

  it('on Android: says what plays now, and that the app is coming soon', async () => {
    asBrowser(USER_AGENTS.androidChrome)
    setConnection()
    await openPage()
    expect(guides()).toHaveAccessibleName('Other devices and apps')
    expect(guideTitles()[0]).toBe('Android app')
    const android = within(firstGuide())
    expect(firstGuide().open).toBe(true)
    expect(android.getByText('Coming soon')).toBeInTheDocument()
    expect(android.getByText(/Chrome on Android can't add extensions/)).toBeInTheDocument()
    expect(android.getByText(/Until it's out, this browser plays free music/)).toBeInTheDocument()
    expect(android.queryByText(/download the APK/)).toBeNull()
    // Nothing to install here yet: no main button.
    expect(within(status()).queryByRole('button')).toBeNull()
    expect(
      within(status()).getByText(/YouTube Music isn't available in this browser/),
    ).toBeVisible()
  })

  it('on iPhone: no install, and the guides are for other devices', async () => {
    asBrowser(USER_AGENTS.iphone)
    setConnection()
    await openPage()
    expect(guides()).toHaveAccessibleName('Other devices and apps')
    expect(guideTitles()[0]).toBe('Safari, iPhone and iPad')
    expect(within(firstGuide()).getByText(/hasn't been tested in Safari yet/)).toBeInTheDocument()
    expect(within(status()).queryByRole('button')).toBeNull()
  })

  it('in Safari on a Mac: points to another browser on the same Mac', async () => {
    asBrowser(USER_AGENTS.safariMac)
    setConnection()
    await openPage()
    expect(guides()).toHaveAccessibleName('Get everything')
    expect(
      within(firstGuide()).getByText(/On this Mac, open FXM in Chrome, Edge, Brave or Firefox/),
    ).toBeInTheDocument()
  })

  it("copies a browser address the page can't link to", async () => {
    asBrowser(USER_AGENTS.chromeWindows)
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
    asBrowser(USER_AGENTS.chromeWindows)
    setConnection({ connect: CONNECT_STATUS.outdated })
    await openPage()
    const update = within(screen.getByRole('region', { name: 'Update FXM Connect' }))
    expect(update.getByText(/0\.0\.9 is too old for this version of FXM/)).toBeInTheDocument()
    expect(update.getByText(/Install version 0\.1\.0 or later/)).toBeInTheDocument()
    expect(update.getByText(/unzip it over the folder/)).toBeInTheDocument()
    expect(update.getByText('chrome://extensions')).toBeInTheDocument()
    // Said once, in the section, not again in the status card.
    expect(within(status()).queryByText(/too old/)).toBeNull()
    expect(within(status()).queryByRole('button')).toBeNull()
  })

  it('says what to do about a missing FXM Connect, and forgets it on request', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    const storage = await storageWithConnectSeen('0.1.0')
    await openTestPlatform({ storage })
    const { user } = await openPage()

    const missing = screen.getByRole('region', { name: "FXM Connect isn't answering" })
    expect(
      within(missing).getByText(/worked in this browser before \(version 0\.1\.0\)/),
    ).toBeVisible()
    expect(within(status()).queryByText(/worked in this browser before/)).toBeNull()
    expect(within(missing).getByText(/turns it off whenever Developer mode is off/)).toBeVisible()
    expect(
      within(missing).getByText(
        'The desktop app needs no extension: it has everything built in. The Android app is coming soon.',
      ),
    ).toBeVisible()
    // The desktop app is out, so it gets a button; the Android app isn't.
    expect(within(missing).getByRole('button', { name: 'Desktop app' })).toBeVisible()
    expect(within(missing).queryByRole('button', { name: /Android app/ })).toBeNull()

    await user.click(within(missing).getByRole('button', { name: 'I removed it on purpose' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: "FXM Connect isn't answering" }),
      ).not.toBeInTheDocument(),
    )
    // Focus moves to the status card, which now says FXM Connect isn't installed.
    expect(document.activeElement).toBe(status())
    expect(within(status()).getByText("FXM Connect isn't installed in this browser.")).toBeVisible()
    expect(useNotices.getState().dismissed).toContain('intro')
  })

  it('in Firefox, says a temporary add-on is gone after a restart', async () => {
    asBrowser(USER_AGENTS.firefoxLinux)
    setConnection({ connect: CONNECT_STATUS.missing })
    await openPage()
    const missing = within(screen.getByRole('region', { name: "FXM Connect isn't answering" }))
    expect(missing.getByText(/Firefox removed it when it restarted/)).toBeVisible()
    expect(missing.getByText('about:debugging#/runtime/this-firefox')).toBeVisible()
    expect(missing.getByText(/Mozilla can block an add-on/)).toBeVisible()
  })

  it('in the desktop app: no extension guides', async () => {
    setConnection({
      platform: 'desktop',
      environment: 'tauri',
      capabilities: TIER_CAPABILITIES.full,
    })
    await openPage()
    expect(within(status()).getByText(/desktop app reaches every service directly/)).toBeVisible()
    expect(screen.queryByRole('region', { name: /Get everything|Other / })).toBeNull()
  })
})
