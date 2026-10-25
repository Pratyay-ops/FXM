import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { getScrobbleStore, resetScrobbling } from './scrobbling'
import { SCROBBLING_STORAGE_KEY, useScrobblingStore } from './scrobbling-store'

const TOKEN = '11111111-2222-4333-8444-555555555555'
const API_KEY = '0123456789abcdef0123456789abcdef'
const SECRET = 'fedcba9876543210fedcba9876543210'
const SESSION_KEY = 'd580d57f32848f5dcf574d1ce18d78b2'
const REQUEST_TOKEN = 'cf45fe5a3e3cebe168480a086d7fe481'

interface Request {
  url: URL
  headers: Headers
  form: Record<string, string>
}

/**
 * Fake ListenBrainz and Last.fm behind `fetch`. ListenBrainz knows only {@link TOKEN}. Last.fm
 * answers `auth.getSession` from `sessions`, one answer per call, then with a session.
 */
function fakeServices() {
  const requests: Request[] = []
  const services = {
    requests,
    sessions: [] as Response[],
    getToken: (): Response => Response.json({ token: REQUEST_TOKEN }),
    down: false,
  }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const form =
      init?.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : {}
    requests.push({ url, headers, form })
    if (services.down) throw new TypeError('Failed to fetch')
    if (url.href === 'https://api.listenbrainz.org/1/validate-token') {
      return headers.get('authorization') === `Token ${TOKEN}`
        ? Response.json({ code: 200, message: 'Token valid.', valid: true, user_name: 'listener' })
        : Response.json({ code: 200, message: 'Token invalid.', valid: false })
    }
    if (url.host === 'api.listenbrainz.org') return Response.json({ status: 'ok' })
    if (url.href === 'https://ws.audioscrobbler.com/2.0/') {
      if (form.method === 'auth.getToken') return services.getToken()
      if (form.method === 'auth.getSession') {
        return (
          services.sessions.shift() ??
          Response.json({ session: { name: 'scrobbler', key: SESSION_KEY, subscriber: 0 } })
        )
      }
      return Response.json({ nowplaying: {} })
    }
    throw new TypeError(`No such host: ${url.host}`)
  })
  return services
}

function row(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function stored(): Record<string, unknown> | undefined {
  return JSON.parse(localStorage.getItem(SCROBBLING_STORAGE_KEY) ?? 'null')?.state
}

let preventNavigation: (event: Event) => void

beforeEach(() => {
  // Links to the services open new tabs; tests stay on the page, and offline.
  preventNavigation = (event) => {
    if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault()
  }
  document.addEventListener('click', preventNavigation, true)
})

afterEach(async () => {
  document.removeEventListener('click', preventNavigation, true)
  vi.unstubAllGlobals()
  await resetScrobbling()
})

describe('Settings → Scrobbling', () => {
  it('is off for both services, and sends nothing, until the user connects one', async () => {
    const services = fakeServices()
    renderApp('/settings')
    expect(await screen.findByRole('heading', { name: 'Scrobbling' })).toBeInTheDocument()
    expect(within(row('ListenBrainz')).getByText(/^Off\./)).toBeInTheDocument()
    expect(within(row('Last.fm')).getByText(/^Off\./)).toBeInTheDocument()
    expect(
      within(row('ListenBrainz')).getByRole('link', { name: /ListenBrainz settings/ }),
    ).toHaveAttribute('href', 'https://listenbrainz.org/settings/')
    expect(within(row('Last.fm')).getByRole('link', { name: /create one/ })).toHaveAttribute(
      'href',
      'https://www.last.fm/api/account/create',
    )
    expect(services.requests).toEqual([])
  })

  it('connects ListenBrainz with a token it accepts, sent only in the Authorization header', async () => {
    const services = fakeServices()
    const { user } = renderApp('/settings')
    const listenbrainz = await screen.findByRole('region', { name: 'ListenBrainz' })
    await user.type(within(listenbrainz).getByLabelText('User token'), ` ${TOKEN} `)
    await user.click(within(listenbrainz).getByRole('button', { name: 'Connect' }))
    expect(
      await within(listenbrainz).findByText(/the songs you play go to the ListenBrainz profile of/),
    ).toHaveTextContent('listener')
    expect(services.requests.map((request) => request.url.href)).toEqual([
      'https://api.listenbrainz.org/1/validate-token',
    ])
    expect(services.requests[0]?.headers.get('authorization')).toBe(`Token ${TOKEN}`)
    expect(stored()).toEqual({ listenbrainz: { token: TOKEN, userName: 'listener' } })
    expect(document.body).not.toHaveTextContent(TOKEN)
  })

  it('explains a token that is malformed, refused or could not be checked', async () => {
    const services = fakeServices()
    const { user } = renderApp('/settings')
    const listenbrainz = await screen.findByRole('region', { name: 'ListenBrainz' })
    const input = within(listenbrainz).getByLabelText('User token')
    const connect = within(listenbrainz).getByRole('button', { name: 'Connect' })

    await user.type(input, 'short')
    await user.click(connect)
    expect(within(listenbrainz).getByRole('alert')).toHaveTextContent(/doesn't look like/)
    expect(services.requests).toEqual([])

    await user.clear(input)
    await user.type(input, '99999999-2222-4333-8444-555555555555')
    await user.click(connect)
    expect(await within(listenbrainz).findByRole('alert')).toHaveTextContent(
      "ListenBrainz doesn't accept this token",
    )

    services.down = true
    await user.click(connect)
    await waitFor(() =>
      expect(within(listenbrainz).getByRole('alert')).toHaveTextContent(
        /couldn't reach ListenBrainz/,
      ),
    )
    expect(stored()?.listenbrainz).toBeUndefined()
  })

  it('shows what waits to be sent, and drops it on disconnecting', async () => {
    fakeServices()
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    act(() =>
      useScrobblingStore.getState().connectListenBrainz({ token: TOKEN, userName: 'listener' }),
    )
    const scrobble = {
      track: { artists: ['Artist'], title: 'Song' },
      startedAt: Date.UTC(2026, 9, 26),
    }
    await getScrobbleStore().add('listenbrainz', [scrobble, scrobble], 100)
    const { user } = renderApp('/settings')
    const listenbrainz = await screen.findByRole('region', { name: 'ListenBrainz' })
    expect(
      await within(listenbrainz).findByText(
        '2 listens waiting to be sent once you are back online.',
      ),
    ).toBeInTheDocument()
    await user.click(within(listenbrainz).getByRole('button', { name: 'Disconnect' }))
    expect(await within(listenbrainz).findByText(/^Off\./)).toBeInTheDocument()
    expect(await getScrobbleStore().count('listenbrainz')).toBe(0)
    expect(stored()?.listenbrainz).toBeUndefined()
  })

  it('pauses an account ListenBrainz refused, and takes a new token', async () => {
    fakeServices()
    act(() => {
      useScrobblingStore
        .getState()
        .connectListenBrainz({ token: 'an-older-token', userName: 'listener' })
      useScrobblingStore.getState().markRefused('listenbrainz', 'an-older-token', 1000)
    })
    const { user } = renderApp('/settings')
    const listenbrainz = await screen.findByRole('region', { name: 'ListenBrainz' })
    expect(
      within(listenbrainz).getByText(/Paused: ListenBrainz no longer accepts the token/),
    ).toBeInTheDocument()
    await user.type(within(listenbrainz).getByLabelText('User token'), TOKEN)
    await user.click(within(listenbrainz).getByRole('button', { name: 'Use this token' }))
    expect(
      await within(listenbrainz).findByText(/the songs you play go to the ListenBrainz profile of/),
    ).toBeInTheDocument()
    expect(useScrobblingStore.getState().listenbrainz).toEqual({
      token: TOKEN,
      userName: 'listener',
    })
  })

  it("connects Last.fm with the user's own API account, through Last.fm's page", async () => {
    const services = fakeServices()
    services.sessions.push(
      Response.json({ message: 'This token has not been authorized', error: 14 }, { status: 403 }),
    )
    const { user } = renderApp('/settings')
    const lastfm = await screen.findByRole('region', { name: 'Last.fm' })
    await user.type(within(lastfm).getByLabelText('API key'), API_KEY)
    await user.type(within(lastfm).getByLabelText('Shared secret'), SECRET)
    await user.click(within(lastfm).getByRole('button', { name: 'Connect' }))

    const open = await within(lastfm).findByRole('link', { name: /Open Last\.fm/ })
    expect(open).toHaveAttribute(
      'href',
      `https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${REQUEST_TOKEN}`,
    )
    expect(open).toHaveAttribute('target', '_blank')
    const [getToken] = services.requests
    expect(getToken?.form).toMatchObject({
      method: 'auth.getToken',
      api_key: API_KEY,
      format: 'json',
    })
    expect(getToken?.form.api_sig).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(services.requests.map((request) => request.form))).not.toContain(SECRET)

    await user.click(open)
    // Not allowed yet: Done says so.
    await user.click(within(lastfm).getByRole('button', { name: 'Done' }))
    expect(await within(lastfm).findByText(/hasn't been told yet/)).toBeInTheDocument()
    // Coming back to the tab finishes by itself.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await within(lastfm).findByText(/go to the Last.fm profile of/)).toHaveTextContent(
      'scrobbler',
    )
    expect(services.requests.map((request) => request.form.method)).toEqual([
      'auth.getToken',
      'auth.getSession',
      'auth.getSession',
    ])
    expect(services.requests[1]?.form.token).toBe(REQUEST_TOKEN)
    expect(stored()?.lastfm).toEqual({
      apiKey: API_KEY,
      secret: SECRET,
      sessionKey: SESSION_KEY,
      userName: 'scrobbler',
    })
    expect(
      within(lastfm).getByRole('link', { name: /Last\.fm application settings/ }),
    ).toHaveAttribute('href', 'https://www.last.fm/settings/applications')
  })

  it('checks the key and secret, and explains what Last.fm refuses', async () => {
    const services = fakeServices()
    const { user } = renderApp('/settings')
    const lastfm = await screen.findByRole('region', { name: 'Last.fm' })
    await user.type(within(lastfm).getByLabelText('API key'), 'not-a-key')
    await user.type(within(lastfm).getByLabelText('Shared secret'), SECRET)
    await user.click(within(lastfm).getByRole('button', { name: 'Connect' }))
    expect(within(lastfm).getByRole('alert')).toHaveTextContent(/32 letters and digits/)
    expect(services.requests).toEqual([])

    services.getToken = () =>
      Response.json(
        { message: 'Invalid API key - You must be granted a valid key by last.fm', error: 10 },
        { status: 403 },
      )
    await user.clear(within(lastfm).getByLabelText('API key'))
    await user.type(within(lastfm).getByLabelText('API key'), API_KEY)
    await user.click(within(lastfm).getByRole('button', { name: 'Connect' }))
    expect(await within(lastfm).findByRole('alert')).toHaveTextContent(
      "Last.fm doesn't accept this API key and shared secret",
    )
  })

  it('starts over when the request expired', async () => {
    const services = fakeServices()
    services.sessions.push(
      Response.json({ message: 'This token has expired', error: 15 }, { status: 403 }),
    )
    const { user } = renderApp('/settings')
    const lastfm = await screen.findByRole('region', { name: 'Last.fm' })
    await user.type(within(lastfm).getByLabelText('API key'), API_KEY)
    await user.type(within(lastfm).getByLabelText('Shared secret'), SECRET)
    await user.click(within(lastfm).getByRole('button', { name: 'Connect' }))
    await user.click(await within(lastfm).findByRole('button', { name: 'Done' }))
    expect(await within(lastfm).findByRole('alert')).toHaveTextContent('That request expired')
    expect(within(lastfm).getByLabelText('API key')).toBeInTheDocument()
  })

  it('connects a refused Last.fm account again with the key it has', async () => {
    const services = fakeServices()
    act(() => {
      useScrobblingStore.getState().connectLastfm({
        apiKey: API_KEY,
        secret: SECRET,
        sessionKey: 'revoked-session',
        userName: 'scrobbler',
      })
      useScrobblingStore.getState().markRefused('lastfm', 'revoked-session', 1000)
    })
    const { user } = renderApp('/settings')
    const lastfm = await screen.findByRole('region', { name: 'Last.fm' })
    expect(within(lastfm).getByText(/Paused: Last\.fm no longer accepts/)).toBeInTheDocument()
    await user.click(within(lastfm).getByRole('button', { name: 'Connect again' }))
    await user.click(await within(lastfm).findByRole('button', { name: 'Done' }))
    expect(await within(lastfm).findByText(/go to the Last.fm profile of/)).toBeInTheDocument()
    expect(services.requests[0]?.form).toMatchObject({ method: 'auth.getToken', api_key: API_KEY })
    expect(useScrobblingStore.getState().lastfm).toMatchObject({ sessionKey: SESSION_KEY })
    expect(useScrobblingStore.getState().lastfm).not.toHaveProperty('refusedAt')
  })
})
