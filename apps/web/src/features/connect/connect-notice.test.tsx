import { CONNECT_SEEN_KEY, memoryStorage } from '@fxm/platform'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { resetConnection } from './connection'
import { useNotices } from './notices'
import {
  CONNECT_STATUS,
  closeTestPages,
  openTestPlatform,
  setConnection,
  TIER_CAPABILITIES,
} from './testing'

afterEach(async () => {
  resetConnection()
  useNotices.setState({ dismissed: [] })
  await closeTestPages()
})

async function home() {
  const view = renderApp('/')
  await screen.findByRole('heading', { level: 1 }, { timeout: 15_000 })
  return view
}

const notice = (name: string | RegExp) => screen.findByRole('region', { name })

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

  it('points a missing FXM Connect to the apps, and goes away when the user removed it', async () => {
    const storage = memoryStorage()
    storage.setItem(CONNECT_SEEN_KEY, JSON.stringify({ version: '0.1.0', at: 1 }))
    await openTestPlatform({ storage })
    const { user } = await home()
    const prompt = await notice("FXM Connect isn't answering")
    expect(within(prompt).getByText(/desktop app or the Android app/)).toBeInTheDocument()
    expect(within(prompt).getByRole('link', { name: 'What to do' })).toHaveAttribute(
      'href',
      '/connect#missing',
    )

    await user.click(within(prompt).getByRole('button', { name: 'I removed it' }))

    // FXM Connect is forgotten: what's left is the first-visit introduction.
    expect(await notice('This browser plays free music')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: "FXM Connect isn't answering" })).toBeNull()
  })

  it('introduces Free only and Lite on a first visit', async () => {
    setConnection()
    await home()
    const free = within(await notice('This browser plays free music'))
    expect(free.getByText(/Internet Archive and Jamendo work here/)).toBeInTheDocument()
    expect(free.getByRole('link', { name: 'See your options' })).toHaveAttribute('href', '/connect')

    act(() => setConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' }))
    expect(await notice('YouTube Music works here without an install')).toBeInTheDocument()
  })

  it('stays dismissed for the same state and version, and comes back for another', async () => {
    setConnection({ connect: CONNECT_STATUS.outdated })
    const { user } = await home()
    await user.click(
      within(await notice('Update FXM Connect')).getByRole('button', { name: 'Dismiss' }),
    )
    expect(screen.queryByRole('region', { name: 'Update FXM Connect' })).toBeNull()
    expect(useNotices.getState().dismissed).toEqual(['outdated:0.0.9'])

    act(() => setConnection({ connect: { ...CONNECT_STATUS.outdated, version: '0.0.10' } }))
    expect(await notice('Update FXM Connect')).toBeInTheDocument()
  })

  it('shows nothing in Full, while detecting and in the apps', async () => {
    const anyNotice = () =>
      screen.queryByRole('region', {
        name: /Update FXM Connect|isn't answering|plays free music|without an install/,
      })
    setConnection({ connect: CONNECT_STATUS.present, capabilities: TIER_CAPABILITIES.full })
    await home()
    expect(anyNotice()).toBeNull()

    act(() => setConnection({ phase: 'detecting' }))
    expect(anyNotice()).toBeNull()

    act(() => setConnection({ platform: 'android' }))
    expect(anyNotice()).toBeNull()
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
