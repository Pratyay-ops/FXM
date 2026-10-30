import { describe, expect, it, vi } from 'vitest'
import { FEATURES, fxmOrigins } from './config.ts'
import { type ContentScriptOptions, startContentScript } from './content-script.ts'
import { MESSAGE, type MessageEventLike } from './messages.ts'

const FXM = 'https://fxmusic.pages.dev'

function fakePage(origin = FXM, withRoot = true) {
  const listeners: ((event: MessageEventLike) => void)[] = []
  const posted: { message: unknown; targetOrigin: string }[] = []
  const dataset: Record<string, string | undefined> = {}
  let ready: (() => void) | undefined
  const document: ContentScriptOptions['document'] = {
    documentElement: withRoot ? { dataset } : null,
    addEventListener: (_type, listener) => {
      ready = listener
    },
  }
  const window: ContentScriptOptions['window'] = {
    location: { origin },
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
  }
  const dispatch = (data: unknown, overrides: Partial<MessageEventLike> = {}) => {
    for (const listener of listeners) listener({ source: window, origin, data, ...overrides })
  }
  const domReady = () => {
    document.documentElement = { dataset }
    ready?.()
  }
  return { window, document, dataset, posted, listeners, dispatch, domReady }
}

/** A background that answers the login status, and nothing else. */
function background(loginEnabled = false, youtubeMusicEnabled = false) {
  return {
    sendMessage: vi.fn(async (message: unknown) => {
      const type = (message as { type?: unknown }).type
      if (type === MESSAGE.loginStatus) return { type: MESSAGE.loginStatus, enabled: loginEnabled }
      if (type === MESSAGE.youtubeMusicLoginStatus) {
        return { type: MESSAGE.youtubeMusicLoginStatus, enabled: youtubeMusicEnabled }
      }
      return undefined
    }),
  }
}

function start(
  page: ReturnType<typeof fakePage>,
  options: Partial<Pick<ContentScriptOptions, 'runtime' | 'origins'>> = {},
) {
  const runtime = options.runtime ?? background()
  const started = startContentScript({
    window: page.window,
    document: page.document,
    runtime,
    origins: options.origins ?? fxmOrigins(false),
    version: '1.2.3',
  })
  return { started, runtime }
}

/** Waits until the content script has posted `count` replies. */
async function replies(page: ReturnType<typeof fakePage>, count = 1) {
  await vi.waitFor(() => expect(page.posted).toHaveLength(count))
  return page.posted.map((post) => post.message)
}

describe('presence', () => {
  it('marks <html> with data-fxm-connect set to the version', () => {
    const page = fakePage()
    expect(start(page).started).toBe(true)
    expect(page.dataset.fxmConnect).toBe('1.2.3')
  })

  it('waits for <html> if it does not exist yet', () => {
    const page = fakePage(FXM, false)
    start(page)
    expect(page.dataset.fxmConnect).toBeUndefined()
    page.domReady()
    expect(page.dataset.fxmConnect).toBe('1.2.3')
  })

  it('does nothing on pages outside the FXM origins', () => {
    for (const origin of ['https://evil.example', 'http://localhost:5173']) {
      const page = fakePage(origin)
      expect(start(page).started).toBe(false)
      expect(page.dataset.fxmConnect).toBeUndefined()
      expect(page.listeners).toHaveLength(0)
    }
  })
})

describe('ping', () => {
  it('answers with the version and features, posted to the page origin only', async () => {
    const page = fakePage()
    start(page)
    page.dispatch({ type: MESSAGE.ping })
    expect(await replies(page)).toEqual([
      { type: MESSAGE.pong, version: '1.2.3', features: [...FEATURES] },
    ])
    expect(page.posted[0]?.targetOrigin).toBe(FXM)
  })

  it('asks the background, which alone can read the setting, whether to announce spotify-login', async () => {
    const page = fakePage()
    const { runtime } = start(page, { runtime: background(true) })
    page.dispatch({ type: MESSAGE.ping })
    const [pong] = await replies(page)
    expect(pong).toMatchObject({ features: [...FEATURES, 'spotify-login'] })
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.loginStatus })
  })

  it('announces YouTube Music login only when the background confirms the opt-in', async () => {
    const page = fakePage()
    const { runtime } = start(page, { runtime: background(false, true) })
    page.dispatch({ type: MESSAGE.ping })
    const [pong] = await replies(page)
    expect(pong).toMatchObject({ features: [...FEATURES, 'youtube-music-login'] })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: MESSAGE.youtubeMusicLoginStatus,
    })
  })

  it('announces both account features independently', async () => {
    const page = fakePage()
    start(page, { runtime: background(true, true) })
    page.dispatch({ type: MESSAGE.ping })
    expect(await replies(page)).toEqual([
      {
        type: MESSAGE.pong,
        version: '1.2.3',
        features: [...FEATURES, 'spotify-login', 'youtube-music-login'],
      },
    ])
  })

  it('still answers when the background is unreachable (extension reloaded under the page)', async () => {
    const page = fakePage()
    start(page, {
      runtime: { sendMessage: vi.fn().mockRejectedValue(new Error('context invalidated')) },
    })
    page.dispatch({ type: MESSAGE.ping })
    expect(await replies(page)).toEqual([
      { type: MESSAGE.pong, version: '1.2.3', features: [...FEATURES] },
    ])
  })

  it('ignores a malformed login status', async () => {
    const page = fakePage()
    const sendMessage = vi.fn(async () => ({ type: MESSAGE.loginStatus, enabled: 'yes' }))
    start(page, { runtime: { sendMessage } })
    page.dispatch({ type: MESSAGE.ping })
    expect(await replies(page)).toEqual([
      { type: MESSAGE.pong, version: '1.2.3', features: [...FEATURES] },
    ])
  })

  it('ignores pings from other windows or origins', async () => {
    const page = fakePage()
    start(page)
    page.dispatch({ type: MESSAGE.ping }, { source: {} })
    page.dispatch({ type: MESSAGE.ping }, { origin: 'https://evil.example' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(page.posted).toEqual([])
  })
})

describe('bridge relay', () => {
  it('forwards valid requests to the background and posts its reply', async () => {
    const page = fakePage()
    const reply = { type: MESSAGE.response, id: 'r1', status: 200, json: { serverTime: 1 } }
    const runtime = { sendMessage: vi.fn(async () => reply) }
    start(page, { runtime })
    page.dispatch({ type: MESSAGE.spotifyServerTime, id: 'r1' })
    expect(await replies(page)).toEqual([reply])
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.spotifyServerTime, id: 'r1' })
  })

  it("passes the background's errors on to the page", async () => {
    const page = fakePage()
    const reply = { type: MESSAGE.error, id: 'r2', code: 'internal' }
    start(page, { runtime: { sendMessage: vi.fn(async () => reply) } })
    page.dispatch({ type: MESSAGE.spotifyServerTime, id: 'r2' })
    expect(await replies(page)).toEqual([reply])
  })

  it('answers unavailable when the background fails or replies with garbage', async () => {
    const page = fakePage()
    const runtime = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Receiving end does not exist'))
        .mockResolvedValueOnce({ type: MESSAGE.response, id: 'other', status: 200, json: null }),
    }
    start(page, { runtime })
    page.dispatch({ type: MESSAGE.spotifyServerTime, id: 1 })
    page.dispatch({ type: MESSAGE.spotifyServerTime, id: 2 })
    expect(await replies(page, 2)).toEqual(
      expect.arrayContaining([
        { type: MESSAGE.error, id: 1, code: 'unavailable' },
        { type: MESSAGE.error, id: 2, code: 'unavailable' },
      ]),
    )
  })

  it('rejects malformed requests itself, without contacting the background', async () => {
    const page = fakePage()
    const { runtime } = start(page)
    page.dispatch({ type: MESSAGE.spotifyToken, id: 5, params: { url: 'https://evil.example' } })
    page.dispatch({ type: 'fxm-connect:fetch', id: 6 })
    expect(await replies(page, 2)).toEqual([
      { type: MESSAGE.error, id: 5, code: 'bad-request' },
      { type: MESSAGE.error, id: 6, code: 'unsupported' },
    ])
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })
})

describe('dev build ruleset switching', () => {
  it('asks the background to activate a localhost origin that shares its host', () => {
    const page = fakePage('http://localhost:4173')
    const { runtime } = start(page, { origins: fxmOrigins(true) })
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.activateOrigin })
  })

  it('answers only once the background has switched rulesets', async () => {
    const page = fakePage('http://localhost:4173')
    let switched: (value: unknown) => void = () => {}
    const sendMessage = vi.fn((message: { type?: unknown }) =>
      message.type === MESSAGE.activateOrigin
        ? new Promise((resolve) => {
            switched = resolve
          })
        : Promise.resolve({ type: MESSAGE.loginStatus, enabled: false }),
    )
    start(page, { runtime: { sendMessage }, origins: fxmOrigins(true) })
    page.dispatch({ type: MESSAGE.ping })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(page.posted).toEqual([])
    switched(null)
    expect(await replies(page)).toEqual([
      { type: MESSAGE.pong, version: '1.2.3', features: [...FEATURES] },
    ])
  })

  it('still answers when the switch fails', async () => {
    const page = fakePage('http://localhost:5173')
    const sendMessage = vi.fn((message: { type?: unknown }) =>
      message.type === MESSAGE.activateOrigin
        ? Promise.reject(new Error('Receiving end does not exist'))
        : Promise.resolve(undefined),
    )
    start(page, { runtime: { sendMessage }, origins: fxmOrigins(true) })
    page.dispatch({ type: MESSAGE.ping })
    expect(await replies(page)).toEqual([
      { type: MESSAGE.pong, version: '1.2.3', features: [...FEATURES] },
    ])
  })

  it('never does so in the production build', () => {
    const { runtime } = start(fakePage())
    expect(runtime.sendMessage).not.toHaveBeenCalledWith({ type: MESSAGE.activateOrigin })
  })
})
