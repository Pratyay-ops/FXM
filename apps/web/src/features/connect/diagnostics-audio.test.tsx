import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { resetConnection } from './connection'
import { createFakeResolver, type FakeSongScenario } from './fake-resolver'
import type { PlaybackProbe } from './playback-probe'
import { setSongResolver, unavailableResolver } from './resolver'
import { closeTestPages, openTestPlatform, type TestPlatformSetup } from './testing'

// The resolver's streams, on googlevideo as the ladder's are, with the query strings that must
// never leave the page.
const HOST = 'rr3---sn-fake1.googlevideo.com'
const GOOD_URL = `https://${HOST}/videoplayback?id=good&ip=203.0.113.7&sig=SECRETSIG`
const BAD_URL = `https://${HOST}/videoplayback?id=bad&ip=203.0.113.7&sig=SECRETSIG`

// happy-dom plays no media: the probe plays the good stream and fails the bad one.
vi.mock('./playback-probe', async (importOriginal) => {
  const original = await importOriginal<typeof import('./playback-probe')>()
  return {
    ...original,
    createPlaybackProbe: (): PlaybackProbe => ({
      prime: vi.fn(),
      canPlay: () => true,
      play: async (url, options) => {
        if (!url.includes('id=good')) {
          return { ok: false, reason: 'media-error', afterMs: 80, playedMs: 0 }
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        return options?.signal?.aborted
          ? { ok: false, reason: 'aborted', afterMs: 20, playedMs: 0 }
          : { ok: true, startedAfterMs: 420, playedMs: 3000 }
      },
      dispose: vi.fn(),
    }),
  }
})

/** How googlevideo answers: one entry per request, in order. */
type Answer = 'readable' | 'opaqueredirect' | 'opaque' | 'network-error' | 'hangs' | number

let answers: Answer[] = []
const googleVideoRequests: { url: string; init: RequestInit }[] = []

function respond(answer: Answer, init: RequestInit): Promise<Response> {
  switch (answer) {
    case 'network-error':
      return Promise.reject(new TypeError('Failed to fetch'))
    case 'hangs':
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    case 'opaqueredirect':
    case 'opaque':
      return Promise.resolve({
        ok: false,
        status: 0,
        type: answer,
        redirected: false,
        url: '',
        body: null,
      } as unknown as Response)
    default: {
      const status = answer === 'readable' ? 206 : answer
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        type: 'cors',
        redirected: false,
        url: GOOD_URL,
        body: new Blob([new Uint8Array(1024)]).stream(),
      } as unknown as Response)
    }
  }
}

beforeEach(() => {
  answers = []
  googleVideoRequests.splice(0)
  const original = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('.googlevideo.com/')) return original(input, init)
    googleVideoRequests.push({ url, init })
    const answer = answers[googleVideoRequests.length - 1]
    if (answer === undefined) return Promise.reject(new Error('Unexpected googlevideo request'))
    return respond(answer, init)
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  resetConnection()
  setSongResolver(unavailableResolver)
  await closeTestPages()
})

async function openDiagnostics() {
  const view = renderApp('/settings')
  const heading = await screen.findByRole(
    'heading',
    { level: 2, name: 'Diagnostics' },
    { timeout: 15_000 },
  )
  const section = heading.closest('section') as HTMLElement
  const row = within(section).getByText('YouTube audio', { selector: 'p' }).parentElement
  return { ...view, section: within(section), row: within(row as HTMLElement) }
}

const runButton = { name: 'Resolve and play one song' }

async function runSelfTest(
  googlevideo: Answer[],
  platform: TestPlatformSetup = { connect: { version: '0.2.0' } },
  scenario: FakeSongScenario = 'plays',
) {
  answers = googlevideo
  const resolver = createFakeResolver(scenario, { urls: { good: GOOD_URL, bad: BAD_URL } })
  setSongResolver(resolver)
  await openTestPlatform(platform)
  const view = await openDiagnostics()
  await waitFor(() => expect(view.section.getByRole('button', runButton)).toBeEnabled())
  await view.user.click(view.section.getByRole('button', runButton))
  return { ...view, resolver }
}

describe('Settings → Diagnostics → YouTube audio', { timeout: 30_000 }, () => {
  it('reads the stream the self-test played, without resolving it again', async () => {
    const { section, row, resolver } = await runSelfTest(['readable'])
    expect(await row.findByText('Readable')).toBeVisible()
    expect(
      row.getByText(
        'FXM Connect can read YouTube audio here, so YouTube downloads and the equalizer work.',
      ),
    ).toBeInTheDocument()
    expect(section.getByText(/^Played 3\.0 s of/)).toBeInTheDocument()
    expect(resolver.resolutions).toHaveLength(1)
    expect(googleVideoRequests.map(({ url }) => url)).toEqual([GOOD_URL])
    expect(googleVideoRequests[0]?.init.headers).toEqual({ Range: 'bytes=0-1023' })
    expect(section.getByRole('button', runButton)).toBeEnabled()
  })

  it('asks FXM Connect 0.2.0 to update when the read is refused', async () => {
    const { row } = await runSelfTest(['network-error', 'opaque'])
    expect(await row.findByText('Refused (CORS)')).toBeVisible()
    expect(
      row.getByText(
        "YouTube's audio server answered, but the browser wouldn't let FXM Connect read the audio, so YouTube downloads and the equalizer don't work.",
      ),
    ).toBeInTheDocument()
    expect(row.getByText('Update FXM Connect to the latest version.')).toBeInTheDocument()
  })

  it('names a hard block after a redirect with an up-to-date FXM Connect', async () => {
    const { row } = await runSelfTest(['opaqueredirect', 'network-error'], {
      connect: { version: '0.2.1' },
    })
    expect(await row.findByText('Redirected to another server and not readable')).toBeVisible()
    expect(
      row.getByText('This browser or network stops FXM Connect from reading YouTube audio.'),
    ).toBeInTheDocument()
    expect(row.queryByText(/Update FXM Connect/)).toBeNull()
  })

  it('shows HTTP errors', async () => {
    const { row } = await runSelfTest([403])
    expect(await row.findByText('HTTP error 403')).toBeVisible()
    expect(row.getByText("YouTube's audio server refused the request.")).toBeInTheDocument()
  })

  it('reads the stream a failed self-test ended on', async () => {
    const { section, row } = await runSelfTest(['readable'], undefined, 'fails')
    expect(await section.findByText('No stream played.')).toBeVisible()
    expect(await row.findByText('Readable')).toBeVisible()
    // The last-resort stream, which the fake marks with a fragment.
    expect(googleVideoRequests.map(({ url }) => url)).toEqual([`${BAD_URL}#fallback`])
  })

  it('has no stream to check when the song could not be resolved', async () => {
    const { section, row } = await runSelfTest([], undefined, 'bot-check')
    expect(await section.findByText(/confirm you're not a bot/)).toBeVisible()
    expect(await row.findByText('The song self-test found no stream to check.')).toBeVisible()
    expect(row.getByText('Not tested.')).toBeInTheDocument()
    expect(googleVideoRequests).toHaveLength(0)
  })

  it('stops with the self-test button', async () => {
    const { section, row, user } = await runSelfTest(['hangs'])
    expect(await row.findByText("Reading the first kilobyte of the song's audio…")).toBeVisible()
    // The self-test's own result shows while the check runs.
    expect(section.getByText(/^Played 3\.0 s of/)).toBeInTheDocument()

    await user.click(section.getByRole('button', { name: 'Stop' }))

    expect(await row.findByText('Stopped.')).toBeVisible()
    expect(googleVideoRequests[0]?.init.signal?.aborted).toBe(true)
    expect(section.getByRole('button', runButton)).toBeEnabled()
  })

  it("isn't tested in Lite, and says why", async () => {
    const { section, row } = await runSelfTest([], { lite: true })
    expect(await section.findByText(/^Played 3\.0 s of/)).toBeVisible()
    expect(row.getByText('Not tested.')).toBeInTheDocument()
    expect(
      row.getByText(
        "In Lite, YouTube songs play, but this browser can't read their audio, so YouTube downloads and the equalizer aren't available here.",
      ),
    ).toBeInTheDocument()
    expect(googleVideoRequests).toHaveLength(0)
  })

  it("isn't tested without FXM Connect, and says why", async () => {
    setSongResolver(createFakeResolver('plays'))
    await openTestPlatform({ lite: false })
    const { section, row } = await openDiagnostics()
    await waitFor(() => expect(section.getByText('Free only')).toBeInTheDocument())
    expect(row.getByText('Not tested.')).toBeInTheDocument()
    expect(
      row.getByText(
        "Without FXM Connect, this browser can't read YouTube audio, so YouTube downloads and the equalizer aren't available here.",
      ),
    ).toBeInTheDocument()
  })
})
