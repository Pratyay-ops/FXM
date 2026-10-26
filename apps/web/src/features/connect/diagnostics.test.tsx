import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { resetConnection } from './connection'
import { budgetSummary, connectSummary, liteSummary, resolveErrorText } from './diagnostics'
import { createFakeResolver, type FakeSongScenario } from './fake-resolver'
import type { PlaybackProbe } from './playback-probe'
import { setSongResolver, unavailableResolver } from './resolver'
import {
  CONNECT_STATUS,
  closeTestPages,
  openTestPlatform,
  setConnection,
  type TestPlatformSetup,
} from './testing'

// happy-dom plays no media: the probe plays `fake://good…` and fails the rest, like a browser
// would the fake resolver's streams.
const probes: PlaybackProbe[] = []
vi.mock('./playback-probe', async (importOriginal) => {
  const original = await importOriginal<typeof import('./playback-probe')>()
  return {
    ...original,
    createPlaybackProbe: (): PlaybackProbe => {
      const probe: PlaybackProbe = {
        prime: vi.fn(),
        canPlay: () => true,
        play: async (url, options) => {
          if (!url.startsWith('fake://good')) {
            return {
              ok: false,
              reason: 'media-error',
              afterMs: 80,
              playedMs: 0,
              detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
          return options?.signal?.aborted
            ? { ok: false, reason: 'aborted', afterMs: 20, playedMs: 0 }
            : { ok: true, startedAfterMs: 420, playedMs: 3000 }
        },
        dispose: vi.fn(),
      }
      probes.push(probe)
      return probe
    },
  }
})

afterEach(async () => {
  resetConnection()
  setSongResolver(unavailableResolver)
  probes.splice(0)
  await closeTestPages()
})

async function openDiagnostics() {
  const view = renderApp('/settings')
  // The first visit loads the page's code, which can take a while on a busy machine.
  const heading = await screen.findByRole(
    'heading',
    { level: 2, name: 'Diagnostics' },
    { timeout: 15_000 },
  )
  return { ...view, section: within(heading.closest('section') as HTMLElement) }
}

const runButton = { name: 'Resolve and play one song' }

describe('Settings → Diagnostics', { timeout: 30_000 }, () => {
  it('shows the tier, why, and the details behind it', async () => {
    await openTestPlatform({ lite: true })
    const { section } = await openDiagnostics()
    await waitFor(() => expect(section.getByText('Lite')).toBeInTheDocument())
    expect(section.getByText('Experimental')).toBeInTheDocument()
    expect(section.getByText(/Lite's check passed/)).toBeInTheDocument()
    expect(section.getByText('Not installed')).toBeInTheDocument()
    expect(section.getByText('Check passed')).toBeInTheDocument()
    expect(section.getByText(/Search and playback through Lite/)).toBeInTheDocument()
    expect(section.getByText('1 of 600 in the last hour')).toBeInTheDocument()
    expect(
      section.getByRole('link', { name: 'What each tier plays, and the install guides' }),
    ).toHaveAttribute('href', '/connect')
  })

  it('keeps a way to the onboarding page in Settings, in a browser', async () => {
    setConnection()
    const { section } = await openDiagnostics()
    expect(section.getByRole('heading', { level: 2, name: 'Diagnostics' })).toBeInTheDocument()
    const entry = screen.getByRole('region', { name: 'FXM Connect' })
    expect(within(entry).getByRole('link', { name: /Tiers and install guides/ })).toHaveAttribute(
      'href',
      '/connect',
    )

    act(() => setConnection({ platform: 'desktop', environment: 'tauri' }))
    expect(screen.queryByRole('region', { name: 'FXM Connect' })).toBeNull()
  })

  it('checks again: re-runs the Lite self-test', async () => {
    const { setLite } = await openTestPlatform({ lite: false })
    const { section, user } = await openDiagnostics()
    await waitFor(() => expect(section.getByText('Free only')).toBeInTheDocument())
    setLite(true)

    await user.click(section.getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(section.getByText('Lite')).toBeInTheDocument())
    expect(section.getByText('Check passed')).toBeInTheDocument()
  })

  it("can't run the song self-test before the stream resolver is wired in", async () => {
    await openTestPlatform({ connect: {} })
    const { section } = await openDiagnostics()
    await waitFor(() => expect(section.getByText('Full')).toBeInTheDocument())
    expect(section.getByText(/can't resolve YouTube songs yet/)).toBeInTheDocument()
    expect(section.getByRole('button', runButton)).toBeDisabled()
  })

  it("can't run it without YouTube access, and offers nothing this device can't get", async () => {
    setSongResolver(createFakeResolver('plays'))
    await openTestPlatform({ lite: false })
    const { section } = await openDiagnostics()
    await waitFor(() => expect(section.getByText('Free only')).toBeInTheDocument())
    expect(
      section.getByText("This browser can't reach YouTube Music, so there is nothing to test."),
    ).toBeInTheDocument()
    expect(section.queryByText(/one of the apps/)).toBeNull()
    expect(section.getByRole('button', runButton)).toBeDisabled()
  })

  async function selfTest(
    scenario: FakeSongScenario,
    platform: TestPlatformSetup = { connect: {} },
  ) {
    const resolver = createFakeResolver(scenario)
    setSongResolver(resolver)
    await openTestPlatform(platform)
    const view = await openDiagnostics()
    await waitFor(() => expect(view.section.getByRole('button', runButton)).toBeEnabled())
    await view.user.click(view.section.getByRole('button', runButton))
    return { ...view, resolver }
  }

  it('resolves and plays the song with FXM Connect', async () => {
    const { section, resolver } = await selfTest('plays')
    expect(
      await section.findByText('Played 3.0 s of Fake stream · 128 kbps · VISIONOS.'),
    ).toBeVisible()
    expect(section.getByText(/playback started 0\.4 s later/)).toBeInTheDocument()
    expect(probes[0]?.prime).toHaveBeenCalled()
    expect(resolver.successes).toHaveLength(1)
  })

  it('in Lite, falls back to the last-resort stream after a failed first request', async () => {
    const { section, resolver } = await selfTest('capped', { lite: true })
    expect(
      await section.findByText('Played 3.0 s of Fake last-resort stream · 128 kbps · ANDROID.'),
    ).toBeVisible()
    expect(
      section.getByText(
        "Fake stream that stops early · 135 kbps · VISIONOS: the browser couldn't play it (MEDIA_ERR_SRC_NOT_SUPPORTED).",
      ),
    ).toBeInTheDocument()
    expect(resolver.failures.map((failure) => failure.reason)).toEqual(['probe-failed'])
  })

  it("reports a song that won't play, and a bot check", async () => {
    const failing = await selfTest('fails')
    expect(await failing.section.findByText('No stream played.')).toBeVisible()
    failing.unmount()
    resetConnection()

    const botCheck = await selfTest('bot-check')
    expect(await botCheck.section.findByText(/confirm you're not a bot/)).toBeVisible()
  })

  it('stops on request', async () => {
    setSongResolver(createFakeResolver('plays', { latencyMs: 10_000 }))
    await openTestPlatform({ connect: {} })
    const { section, user } = await openDiagnostics()
    await waitFor(() => expect(section.getByRole('button', runButton)).toBeEnabled())
    await user.click(section.getByRole('button', runButton))
    expect(await section.findByText('Resolving the song…')).toBeVisible()

    await user.click(section.getByRole('button', { name: 'Stop' }))

    expect(await section.findByText('Stopped.')).toBeVisible()
    expect(section.getByRole('button', runButton)).toBeEnabled()
  })
})

describe('the summaries', () => {
  it('describe FXM Connect in each state', () => {
    expect(connectSummary(CONNECT_STATUS.present, 'web')).toBe('Version 0.1.0, on')
    expect(connectSummary(CONNECT_STATUS.outdated, 'web')).toBe(
      'Version 0.0.9, too old: FXM needs 0.1.0 or later',
    )
    expect(connectSummary(CONNECT_STATUS.missing, 'web')).toBe(
      'Not answering, though version 0.1.0 worked here before',
    )
    expect(connectSummary(undefined, 'desktop')).toBe('Not needed in the app')
  })

  it('describe Lite in each state', () => {
    expect(liteSummary('not-needed', 'web')).toMatch(/FXM Connect gives full access/)
    expect(liteSummary('switched-off', 'web')).toMatch(/Switched off/)
    expect(liteSummary('failed', 'web')).toMatch(/didn't pass/)
  })

  it('describe the budget, with a pause after a bot check', () => {
    expect(budgetSummary(undefined)).toBe('Not started yet')
    const snapshot = {
      hourlyLimit: 600,
      used: 12,
      remaining: 588,
      pauseLevel: 1,
      waitingBulk: 0,
      bulkPausedUntil: Date.parse('2026-10-26T10:30:00Z'),
    }
    expect(budgetSummary(snapshot, Date.parse('2026-10-26T10:00:00Z'))).toMatch(
      /^12 of 600 in the last hour\. After a bot check, background work such as imports waits until .+; playback goes on\.$/,
    )
    expect(budgetSummary(snapshot, Date.parse('2026-10-26T11:00:00Z'))).toBe(
      '12 of 600 in the last hour',
    )
  })

  it('explain resolver errors in plain words', () => {
    expect(resolveErrorText(new Error('x'))).toBe("The song couldn't be resolved.")
  })
})
