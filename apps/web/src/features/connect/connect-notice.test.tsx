import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { noticeCopy } from './connect-notice'
import { resetConnection, useConnection } from './connection'
import { detectDevice } from './device'
import { useNotices } from './notices'
import {
  asBrowser,
  CONNECT_STATUS,
  closeTestPages,
  DETECTING,
  openTestPlatform,
  readyConnection,
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

async function home(path = '/') {
  const view = renderApp(path)
  await screen.findByRole('heading', { level: 1 }, { timeout: 15_000 })
  return view
}

const notice = (name: string | RegExp) => screen.findByRole('region', { name })
const anyNotice = () =>
  screen.queryByRole('region', {
    name: /Update FXM Connect|isn't answering|plays free music|without an install/,
  })

describe('the connection notice', { timeout: 30_000 }, () => {
  it('prompts an upgrade for an outdated FXM Connect', async () => {
    setConnection({ connect: CONNECT_STATUS.outdated })
    await home()
    const prompt = within(await notice('Update FXM Connect'))
    expect(prompt.getByText(/0\.0\.9 is too old for this version of FXM/)).toBeInTheDocument()
    expect(prompt.getByText(/needs 0\.1\.0 or later/)).toBeInTheDocument()
    expect(prompt.getByRole('link', { name: 'How to update' })).toHaveAttribute(
      'href',
      '/connect#update',
    )
  })

  it('mentions Lite as the meanwhile when its check passed', async () => {
    setConnection({
      connect: CONNECT_STATUS.outdated,
      capabilities: TIER_CAPABILITIES.lite,
      lite: 'passed',
    })
    await home()
    expect(within(await notice('Update FXM Connect')).getByText(/Meanwhile/)).toBeInTheDocument()
  })

  it('floats after the page, not above it, so it never pushes the page down', async () => {
    setConnection()
    await home()
    const intro = await notice('This browser plays free music')
    const heading = screen.getByRole('heading', { level: 1 })
    // After the page's content in the document, in a fixed layer.
    expect(heading.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(intro.parentElement).toHaveClass('fixed')
    expect(intro.parentElement).toHaveAttribute('aria-live', 'polite')
    // Other floating layers can keep clear of it.
    expect(document.documentElement.style.getPropertyValue('--connect-notice-space')).toMatch(
      /^\d+(\.\d+)?px$/,
    )
  })

  it('says what to do about a missing FXM Connect, and goes away for good when removed', async () => {
    const storage = await storageWithConnectSeen('0.1.0')
    await openTestPlatform({ storage })
    const { user } = await home()
    const prompt = within(await notice("FXM Connect isn't answering"))
    expect(prompt.getByText(/turned off, removed or blocked/)).toBeInTheDocument()
    // No app is out yet, so none is offered.
    expect(prompt.queryByText(/desktop app|Android app|one of the apps/)).toBeNull()
    expect(prompt.getByRole('link', { name: 'What to do' })).toHaveAttribute(
      'href',
      '/connect#missing',
    )

    await user.click(prompt.getByRole('button', { name: 'I removed it' }))

    // FXM Connect is forgotten, and the invitation to add it doesn't take the warning's place.
    await waitFor(() => expect(useConnection.getState().connect?.state).toBe('absent'))
    expect(anyNotice()).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('introduces Free only and Lite on a first visit', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    setConnection()
    await home()
    const free = within(await notice('This browser plays free music'))
    expect(
      free.getByText(
        'Internet Archive works here. For YouTube Music and Spotify, add the free FXM Connect extension.',
      ),
    ).toBeInTheDocument()
    expect(free.getByRole('link', { name: 'See your options' })).toHaveAttribute('href', '/connect')

    act(() => setConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' }))
    const lite = within(await notice('Try YouTube Music here without an install (experimental)'))
    expect(
      lite.getByText(
        "This browser passed Lite's check. For Spotify, add the free FXM Connect extension.",
      ),
    ).toBeInTheDocument()
  })

  it('introduces the tiers on the tab pages only, and warns on every page but Now playing', async () => {
    setConnection()
    const { router } = await home('/settings')
    expect(anyNotice()).toBeNull()

    await act(() => router.navigate('/library'))
    expect(await notice('This browser plays free music')).toBeInTheDocument()

    act(() => setConnection({ connect: CONNECT_STATUS.outdated }))
    await act(() => router.navigate('/settings'))
    expect(await notice('Update FXM Connect')).toBeInTheDocument()

    await act(() => router.navigate('/now-playing'))
    await screen.findByRole('heading', { level: 1, name: 'Now playing' })
    expect(anyNotice()).toBeNull()
  })

  it('stays dismissed for the same state and version, and comes back for another', async () => {
    setConnection({ connect: CONNECT_STATUS.outdated })
    const { user } = await home()
    await user.click(
      within(await notice('Update FXM Connect')).getByRole('button', { name: 'Dismiss' }),
    )
    expect(screen.queryByRole('region', { name: 'Update FXM Connect' })).toBeNull()
    expect(useNotices.getState().dismissed).toEqual(['outdated:0.0.9'])
    // Focus stays on the page, not on <body>.
    expect(document.activeElement).toBe(document.getElementById('main'))

    act(() => setConnection({ connect: { ...CONNECT_STATUS.outdated, version: '0.0.10' } }))
    expect(await notice('Update FXM Connect')).toBeInTheDocument()
  })

  it('shows nothing in Full, while detecting and in the apps', async () => {
    setConnection({ connect: CONNECT_STATUS.present, capabilities: TIER_CAPABILITIES.full })
    await home()
    expect(anyNotice()).toBeNull()

    act(() => useConnection.setState(DETECTING, true))
    expect(anyNotice()).toBeNull()

    act(() => setConnection({ platform: 'android' }))
    expect(anyNotice()).toBeNull()
  })

  it('warns as soon as FXM Connect answers, before the Lite check is done', async () => {
    useConnection.setState(
      { ...DETECTING, connect: CONNECT_STATUS.missing, lite: 'checking' },
      true,
    )
    await home()
    expect(await notice("FXM Connect isn't answering")).toBeInTheDocument()
  })

  it('leaves the onboarding page to say it itself', async () => {
    setConnection({ connect: CONNECT_STATUS.outdated })
    renderApp('/connect')
    await screen.findByRole('heading', { level: 1, name: 'FXM Connect' }, { timeout: 15_000 })
    // Only the page's own section, with the steps: no notice with a link to them.
    const sections = await screen.findAllByRole('region', { name: 'Update FXM Connect' })
    expect(sections).toHaveLength(1)
    expect(within(sections[0] as HTMLElement).getByText(/Install version 0\.1\.0/)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'How to update' })).toBeNull()
  })
})

describe('what the notice says on each device', () => {
  const free = readyConnection()
  const lite = readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })
  const intro = { kind: 'intro', id: 'intro' } as const
  const body = (userAgent: string, state = free) =>
    noticeCopy(intro, state, detectDevice({ userAgent })).body

  it('offers the extension where the browser can add it', () => {
    expect(body(USER_AGENTS.firefoxLinux)).toBe(
      'Internet Archive works here. For YouTube Music and Spotify, add the free FXM Connect extension.',
    )
  })

  it('names Jamendo only in a build that offers it', () => {
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', 'public-id')
    try {
      expect(body(USER_AGENTS.firefoxLinux)).toBe(
        'Internet Archive and Jamendo work here. For YouTube Music and Spotify, add the free FXM Connect extension.',
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('sends Safari on a Mac to another browser on the same Mac', () => {
    expect(body(USER_AGENTS.safariMac)).toBe(
      "Internet Archive works here. YouTube Music and Spotify need FXM Connect, which Safari can't add. On this Mac, open FXM in Chrome, Edge, Brave or Firefox and add it there.",
    )
  })

  it('offers nothing to install on iPhone and iPad', () => {
    expect(body(USER_AGENTS.iphone)).toBe(
      "Internet Archive works here. YouTube Music and Spotify need FXM Connect, which isn't available on iPhone and iPad.",
    )
    expect(body(USER_AGENTS.iphone, lite)).toBe(
      "This browser passed Lite's check. Spotify needs FXM Connect, which isn't available on iPhone and iPad.",
    )
  })

  it('says the Android app is coming soon on Android, without offering it', () => {
    expect(body(USER_AGENTS.androidChrome)).toBe(
      "Internet Archive works here. YouTube Music and Spotify need FXM Connect, which browsers on Android can't add. The Android app is coming soon.",
    )
  })

  it('marks the Lite introduction experimental, and the warnings as warnings', () => {
    const device = detectDevice({ userAgent: USER_AGENTS.chromeWindows })
    expect(noticeCopy(intro, lite, device)).toMatchObject({
      title: 'Try YouTube Music here without an install (experimental)',
      tone: 'info',
    })
    expect(
      noticeCopy(
        { kind: 'missing', id: 'missing:0.1.0' },
        readyConnection({ connect: CONNECT_STATUS.missing }),
        device,
      ),
    ).toMatchObject({ tone: 'warning' })
  })
})
