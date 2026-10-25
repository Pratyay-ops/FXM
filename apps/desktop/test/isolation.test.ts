import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { siteOrigin } from '@fxm/platform'
import { describe, expect, it } from 'vitest'

// Runs the desktop app's isolation hook (isolation/hook.js) as Tauri's isolation frame does: a
// plain script that sets `window.__TAURI_ISOLATION_HOOK__`, called with every IPC message.

interface IpcMessage {
  cmd: string
  callback: number
  error: number
  payload: unknown
  options?: unknown
}

type Hook = (message: IpcMessage) => IpcMessage

const source = readFileSync(new URL('../isolation/hook.js', import.meta.url), 'utf8')

/** A fresh copy of the hook, in a context of its own, as in the isolation frame. */
function loadHook(): Hook {
  const window: { __TAURI_ISOLATION_HOOK__?: Hook } = {}
  runInNewContext(source, { window, URL })
  const hook = window.__TAURI_ISOLATION_HOOK__
  if (typeof hook !== 'function') throw new Error('hook.js sets no __TAURI_ISOLATION_HOOK__')
  return hook
}

const hook = loadHook()

/** A `plugin:http|fetch` message as `@tauri-apps/plugin-http` sends it. */
function fetchMessage(clientConfig: Record<string, unknown>): IpcMessage {
  return {
    cmd: 'plugin:http|fetch',
    callback: 1,
    error: 2,
    payload: {
      clientConfig: {
        method: 'GET',
        url: 'https://lrclib.net/api/get',
        headers: [],
        data: null,
        ...clientConfig,
      },
    },
  }
}

/** What reaches Rust for a request with `headers`. */
function sentHeaders(headers: unknown): unknown {
  const message = hook(fetchMessage({ headers }))
  return (message.payload as { clientConfig: { headers: unknown } }).clientConfig.headers
}

describe('the isolation hook', () => {
  it('drops a per-request proxy and TLS exceptions from every plugin request', () => {
    const message = hook(
      fetchMessage({
        proxy: {
          all: { url: 'http://192.168.1.1:22', basicAuth: { username: 'x', password: 'y' } },
        },
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
        maxRedirections: 0,
        connectTimeout: 15_000,
      }),
    )
    const config = (message.payload as { clientConfig: Record<string, unknown> }).clientConfig
    expect('proxy' in config).toBe(false)
    expect('danger' in config).toBe(false)
    expect(config).toMatchObject({ maxRedirections: 0, connectTimeout: 15_000 })
  })

  it('drops Cookie, Cookie2, Host and Proxy-* headers, in any case', () => {
    expect(
      sentHeaders([
        ['Cookie', 'SID=secret'],
        ['cookie2', 'x'],
        ['HOST', 'evil.example'],
        ['proxy-authorization', 'Basic eA=='],
        ['Proxy-Connection', 'keep-alive'],
        ['range', 'bytes=-65536'],
        ['user-agent', 'Mozilla/5.0'],
      ]),
    ).toEqual([
      ['range', 'bytes=-65536'],
      ['user-agent', 'Mozilla/5.0'],
      ['origin', ''],
    ])
  })

  it('never lets the webview’s origin through, and sends exactly one Origin', () => {
    expect(sentHeaders([])).toEqual([['origin', '']])
    expect(sentHeaders([['Origin', 'tauri://localhost']])).toEqual([['origin', '']])
    expect(
      sentHeaders([
        ['origin', 'https://open.spotify.com'],
        ['origin', 'http://tauri.localhost'],
      ]),
    ).toEqual([['origin', '']])
    expect(sentHeaders([['origin', 'https://open.spotify.com']])).toEqual([
      ['origin', 'https://open.spotify.com'],
    ])
  })

  it.each([
    undefined,
    '',
    'null',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:5260',
    'https://localhost',
    'http://open.spotify.com',
    'https://open.spotify.com/',
    'https://user@open.spotify.com',
    'not an origin',
    'https://open.spotify.com',
    'https://www.youtube.com',
  ])('judges the origin %j as createDesktopFetch does', (origin) => {
    const headers = origin === undefined ? [] : [['origin', origin]]
    expect(sentHeaders(headers)).toEqual([['origin', siteOrigin(origin)]])
  })

  it('leaves what FXM’s own requests send as it is', () => {
    // As createDesktopFetch sends a Spotify request through the plugin.
    const headers = [
      ['accept', 'application/json'],
      ['origin', 'https://open.spotify.com'],
      ['user-agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
    ]
    expect(sentHeaders(headers)).toEqual([headers[0], headers[2], headers[1]])
  })

  it('drops malformed header entries instead of passing them on', () => {
    expect(sentHeaders('origin: x')).toEqual([['origin', '']])
    expect(sentHeaders([['x-a'], ['x-b', 1], 'x-c', ['x-d', 'kept']])).toEqual([
      ['x-d', 'kept'],
      ['origin', ''],
    ])
  })

  it('passes every other message as it is', () => {
    const messages: IpcMessage[] = [
      { cmd: 'user_host_fetch', callback: 1, error: 2, payload: { request: { url: 'x' } } },
      { cmd: 'plugin:http|fetch_send', callback: 1, error: 2, payload: { rid: 3 } },
      { cmd: 'plugin:event|emit', callback: 1, error: 2, payload: { event: 'x', proxy: 'kept' } },
      { cmd: 'plugin:http|fetch', callback: 1, error: 2, payload: [1, 2, 3] },
    ]
    for (const message of messages) {
      const copy = structuredClone(message)
      expect(hook(message)).toEqual(copy)
    }
  })
})
