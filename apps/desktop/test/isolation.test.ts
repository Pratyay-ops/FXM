import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import {
  EVALUATOR_CHANNEL,
  HELLO_SCRIPT,
  receiveScript,
  siteOrigin,
  TAURI_EVALUATOR_PLUGIN,
  takeScript,
} from '@fxm/platform'
import { describe, expect, it } from 'vitest'

// Runs the desktop app's isolation hook (isolation/hook.js) the way Tauri's isolation frame does,
// then reads what Rust would read. The frame gets a structured clone of each message the page
// posts, calls the hook, and encrypts what Tauri's serializer makes of the payload the hook
// returns (`encrypted` below). Only that payload is encrypted: page script can resend it under
// any command and label it JSON, so the checks read every payload as a request for the HTTP
// plugin's `fetch`, whatever command the message named.

/**
 * The releases this file copies from: the serializer from tauri's
 * scripts/process-ipc-message-fn.js, the frame's steps (hook, serializer, bytes) from
 * tauri-utils' src/pattern/isolation.js, and the request's fields from tauri-plugin-http's
 * `ClientConfig` (src/commands.rs), which the hook's REQUEST_FIELDS also follow.
 */
const COPIED_FROM = { tauri: '2.12.3', 'tauri-utils': '2.10.1', 'tauri-plugin-http': '2.8.2' }

interface IpcMessage {
  cmd: unknown
  callback: number
  error: number
  payload: unknown
  options?: unknown
}

type Hook = (message: IpcMessage) => IpcMessage

/** A request for the HTTP plugin's `fetch`, as Rust reads it (its `ClientConfig`). */
type PluginRequest = Record<string, unknown>

const TO_IPC = '__TAURI_TO_IPC_KEY__'

/** What the hook puts where it refuses a request. */
const REFUSED = 'refused by the FXM isolation hook'

/**
 * The fields of tauri-plugin-http 2.8.2's `ClientConfig`, in order. serde also reads them from an
 * array, by position.
 */
const REQUEST_FIELDS = [
  'method',
  'url',
  'headers',
  'data',
  'connectTimeout',
  'maxRedirections',
  'proxy',
  'danger',
]

const source = readFileSync(new URL('../isolation/hook.js', import.meta.url), 'utf8')

/**
 * The hook, run as the plain script it is. It runs in this realm, so the Maps and typed arrays of
 * the test's structured clones are its own, as the frame's clones are the frame's.
 */
function loadHook(): Hook {
  const window: { __TAURI_ISOLATION_HOOK__?: Hook } = {}
  const script = runInThisContext(`(function (window) {\n${source}\n})`) as (w: object) => void
  script(window)
  const hook = window.__TAURI_ISOLATION_HOOK__
  if (typeof hook !== 'function') throw new Error('hook.js sets no __TAURI_ISOLATION_HOOK__')
  return hook
}

const hook = loadHook()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bytesOf(data: ArrayBuffer | ArrayBufferView | unknown[]): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(data as number[])
}

/**
 * What the frame encrypts for `payload`, with the content type it gives it: an array, an
 * ArrayBuffer or a view as its bytes; anything else as JSON, with Maps as objects and Uint8Arrays
 * and ArrayBuffers as arrays of numbers. Throws where the serializer throws: the frame then sends
 * nothing.
 */
function encrypted(payload: unknown): { contentType: string; bytes: Uint8Array } {
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload) || Array.isArray(payload)) {
    return { contentType: 'application/octet-stream', bytes: bytesOf(payload) }
  }
  const json = JSON.stringify(payload, (_key, value: unknown) => {
    if (value instanceof Map) return Object.fromEntries(value.entries())
    if (value instanceof Uint8Array) return Array.from(value)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    if (typeof value === 'object' && value !== null && TO_IPC in value) {
      return (value as { [TO_IPC]: () => unknown })[TO_IPC]()
    }
    return value
  })
  const bytes = json === undefined ? new Uint8Array() : new TextEncoder().encode(json)
  return { contentType: 'application/json', bytes }
}

/**
 * The request the plugin's `fetch` gets from `bytes` labelled JSON, as page script can label any
 * payload, or `undefined` when Rust refuses them. Labelled as bytes, they give no command any
 * argument.
 */
function requestRustReads(bytes: Uint8Array): PluginRequest | undefined {
  let args: unknown
  try {
    args = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (!isRecord(args) || !Object.hasOwn(args, 'clientConfig')) return undefined
  const config = args.clientConfig
  if (Array.isArray(config)) {
    if (config.length !== REQUEST_FIELDS.length) return undefined
    return Object.fromEntries(REQUEST_FIELDS.map((field, index) => [field, config[index]]))
  }
  return isRecord(config) ? config : undefined
}

/**
 * What reaches the plugin's `fetch` when the page posts `message` to the frame, whatever command
 * and content type the page then gives the encrypted payload.
 */
function reachesFetch(message: IpcMessage, through: Hook = hook): PluginRequest | undefined {
  const { payload } = through(structuredClone(message))
  try {
    return requestRustReads(encrypted(payload).bytes)
  } catch {
    return undefined // the serializer threw, so the frame sends nothing
  }
}

/** The name of a header entry, lower-cased, or '' for a malformed one. */
const headerName = (entry: unknown) =>
  Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0].toLowerCase() : ''

/**
 * Fails unless `request` keeps the hook's rules: no proxy, no TLS exceptions, no Cookie, Cookie2,
 * Host or Proxy-* header, and exactly one Origin, a real site's or none.
 */
function expectAllowed(request: PluginRequest | undefined): void {
  if (request === undefined) return
  expect(request.proxy ?? null).toBeNull()
  expect(request.danger ?? null).toBeNull()
  const headers: unknown[] = Array.isArray(request.headers) ? request.headers : []
  const names = headers.map(headerName)
  expect(names.filter((name) => /^(cookie2?|host|proxy-.*)$/.test(name))).toEqual([])
  const origins = headers.filter((entry) => headerName(entry) === 'origin') as unknown[][]
  expect(origins).toHaveLength(1)
  const origin = origins[0]?.[1]
  expect(origin === '' || siteOrigin(String(origin)) === origin).toBe(true)
}

/** A message as Tauri's `invoke` posts it to the frame. */
const message = (payload: unknown, cmd: unknown = 'plugin:http|fetch'): IpcMessage => ({
  cmd,
  callback: 1,
  error: 2,
  payload,
})

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** A String object, which a structured clone keeps and JSON.stringify turns into a string. */
const boxed = (text: string): unknown => Object(text)

/** A request with everything the hook's rules take out. */
function attack(): PluginRequest {
  return {
    method: 'GET',
    url: 'https://lrclib.net/api/get',
    headers: [
      ['Cookie', 'SID=secret'],
      ['cookie2', 'x'],
      ['HOST', 'evil.example'],
      ['Proxy-Authorization', 'Basic eA=='],
      ['Origin', 'tauri://localhost'],
    ],
    data: null,
    connectTimeout: 15_000,
    maxRedirections: 0,
    proxy: { all: { url: 'http://192.168.1.1:22', basicAuth: { username: 'x', password: 'y' } } },
    danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
  }
}

/** The attack once the hook has applied its rules. */
const ALLOWED: PluginRequest = {
  method: 'GET',
  url: 'https://lrclib.net/api/get',
  headers: [['origin', '']],
  data: null,
  connectTimeout: 15_000,
  maxRedirections: 0,
}

/**
 * Ways to get the attack to the plugin, and what the hook lets reach it: the request without what
 * the rules take out, or nothing.
 */
const ATTACKS: [string, IpcMessage, PluginRequest | undefined][] = [
  ['the plugin’s own payload', message({ clientConfig: attack() }), ALLOWED],
  ['a Map payload', message(new Map([['clientConfig', attack()]])), ALLOWED],
  ['a Map request', message({ clientConfig: new Map(Object.entries(attack())) }), ALLOWED],
  [
    'Maps in Maps',
    message(
      new Map([
        [
          'clientConfig',
          new Map(Object.entries({ ...attack(), proxy: new Map([['all', 'http://10.0.0.1:25']]) })),
        ],
      ]),
    ),
    ALLOWED,
  ],
  [
    'a Map keyed by a String object',
    message(new Map([[boxed('clientConfig'), attack()]])),
    ALLOWED,
  ],
  [
    'another command’s payload, resent as the plugin’s',
    message({ clientConfig: attack() }, 'plugin:event|emit'),
    ALLOWED,
  ],
  [
    'an app command’s payload, resent as the plugin’s',
    message({ clientConfig: attack() }, 'user_host_fetch'),
    ALLOWED,
  ],
  [
    'a command named by a String object',
    message({ clientConfig: attack() }, boxed('plugin:http|fetch')),
    ALLOWED,
  ],
  [
    'header names and values in String objects',
    message({
      clientConfig: {
        ...attack(),
        headers: [
          [boxed('cookie'), 'SID=secret'],
          ['origin', boxed('tauri://localhost')],
        ],
      },
    }),
    ALLOWED,
  ],
  [
    'a request read by position',
    message({ clientConfig: REQUEST_FIELDS.map((field) => attack()[field]) }),
    undefined,
  ],
  [
    'JSON in a Uint8Array, labelled JSON',
    message(jsonBytes({ clientConfig: attack() })),
    undefined,
  ],
  [
    'JSON in an ArrayBuffer, labelled JSON',
    message(jsonBytes({ clientConfig: attack() }).buffer),
    undefined,
  ],
  [
    'JSON in a DataView, labelled JSON',
    message(new DataView(jsonBytes({ clientConfig: attack() }).buffer)),
    undefined,
  ],
  [
    'JSON as an array of byte values, labelled JSON',
    message(Array.from(jsonBytes({ clientConfig: attack() }))),
    undefined,
  ],
]

/** Messages the app itself sends, as `@tauri-apps/api` and `@tauri-apps/plugin-http` post them. */
const FXM_MESSAGES: [string, IpcMessage][] = [
  [
    'an InnerTube search',
    message({
      clientConfig: {
        method: 'POST',
        url: 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
        headers: [
          ['content-type', 'text/plain;charset=UTF-8'],
          ['user-agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
          ['origin', ''],
        ],
        data: Array.from(jsonBytes({ query: 'Radiohead Creep' })),
        connectTimeout: 15_000,
        proxy: undefined,
        danger: undefined,
      },
    }),
  ],
  [
    'a Spotify request',
    message({
      clientConfig: {
        method: 'GET',
        url: 'https://open.spotify.com/api/server-time',
        headers: [
          ['accept', 'application/json'],
          ['user-agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
          ['origin', 'https://open.spotify.com'],
        ],
        data: null,
        connectTimeout: 15_000,
      },
    }),
  ],
  [
    'a range probe that follows no redirect',
    message({
      clientConfig: {
        method: 'GET',
        url: 'https://archive.org/download/long_temple_bell/long_temple_bell.mp3',
        headers: [
          ['range', 'bytes=-65536'],
          ['user-agent', 'FXM ( https://github.com/Pratyay-ops/FXM )'],
          ['origin', ''],
        ],
        data: null,
        maxRedirections: 0,
        connectTimeout: 15_000,
      },
    }),
  ],
  ['fetch_send', message({ rid: 3 }, 'plugin:http|fetch_send')],
  ['fetch_read_body', message({ rid: 4 }, 'plugin:http|fetch_read_body')],
  ['fetch_cancel_body', message({ rid: 4 }, 'plugin:http|fetch_cancel_body')],
  [
    'an event listener',
    message({ event: 'fxm-smoke-log', target: { kind: 'Any' }, handler: 7 }, 'plugin:event|listen'),
  ],
  [
    'an event',
    message({ event: 'fxm-smoke-report', payload: { ok: true, steps: [] } }, 'plugin:event|emit'),
  ],
  [
    'user_host_fetch',
    message(
      { request: { url: 'https://invidious.example/api/v1/stats', method: 'GET' } },
      'user_host_fetch',
    ),
  ],
  ['approve_user_host', message({ host: 'invidious.example' }, 'approve_user_host')],
  ['a command without arguments', message({}, 'user_hosts')],
  // Stage 7.3's playback bridge (bridge/shell.ts): the tray's text, where the app runs, and the
  // tray's and the network's events.
  [
    'set_now_playing',
    message(
      { now: { state: 'playing', title: 'Mrs. Robinson 🎶', artist: 'Simon & Garfunkel' } },
      'set_now_playing',
    ),
  ],
  ['desktop_environment', message({}, 'desktop_environment')],
  [
    'a listener for the tray’s media actions',
    message(
      { event: 'fxm-media-action', target: { kind: 'Any' }, handler: 8 },
      'plugin:event|listen',
    ),
  ],
  [
    'an event listener’s end',
    message({ event: 'fxm-network-change', eventId: 9 }, 'plugin:event|unlisten'),
  ],
  ['a request for a channel’s data', message(null, 'plugin:__TAURI_CHANNEL__|fetch')],
  // Stage 1.11's evaluator plugin, as `createTauriEvaluator` drives it: the scripts read and fill
  // the evaluator document's mailbox.
  ['the evaluator’s open', message({}, `plugin:${TAURI_EVALUATOR_PLUGIN}|open`)],
  [
    'the evaluator’s hello',
    message({ script: HELLO_SCRIPT }, `plugin:${TAURI_EVALUATOR_PLUGIN}|eval`),
  ],
  [
    'a request for the evaluator',
    message(
      {
        script: receiveScript({
          channel: EVALUATOR_CHANNEL,
          id: 1,
          method: 'evaluate',
          params: { source: 'return args[0] + "\u00e9"', args: ['caf'] },
        }),
      },
      `plugin:${TAURI_EVALUATOR_PLUGIN}|eval`,
    ),
  ],
  [
    'an evaluator’s answer',
    message({ script: takeScript(1) }, `plugin:${TAURI_EVALUATOR_PLUGIN}|eval`),
  ],
  ['the evaluator’s close', message({}, `plugin:${TAURI_EVALUATOR_PLUGIN}|close`)],
]

/** The headers that reach Rust for a request with `headers`. */
function sentHeaders(headers: unknown): unknown {
  return reachesFetch(message({ clientConfig: { ...ALLOWED, headers } }))?.headers
}

describe('the isolation hook', () => {
  it.each(ATTACKS)('keeps the rules for %s', (_name, sent, reaching) => {
    const request = reachesFetch(sent)
    expectAllowed(request)
    expect(request).toEqual(reaching)
  })

  it.each(ATTACKS)('is what stops a proxy in %s', (_name, sent) => {
    // The frame as this file copies it lets every one of these through without the hook.
    expect(reachesFetch(sent, (received) => received)?.proxy).toBeTruthy()
  })

  it.each(FXM_MESSAGES)('sends %s to Rust byte for byte', (_name, sent) => {
    const before = encrypted(structuredClone(sent).payload)
    expect(encrypted(hook(structuredClone(sent)).payload)).toEqual(before)
  })

  it('never returns a payload that the frame would send as bytes', () => {
    for (const [name, sent] of [...ATTACKS, ...FXM_MESSAGES]) {
      expect(encrypted(hook(structuredClone(sent)).payload).contentType, name).toBe(
        'application/json',
      )
    }
  })

  it('puts the reason where it refused a request, so the plugin’s error names it', () => {
    expect(hook(structuredClone(message(jsonBytes({ clientConfig: attack() })))).payload).toEqual({
      clientConfig: REFUSED,
    })
    expect(hook(structuredClone(message({ clientConfig: ['GET'] }))).payload).toEqual({
      clientConfig: REFUSED,
    })
  })

  it.each([
    [
      'a cycle',
      () => {
        const payload: Record<string, unknown> = { clientConfig: attack() }
        payload.self = payload
        return payload
      },
    ],
    ['a BigInt', () => ({ clientConfig: { ...attack(), connectTimeout: 15_000n } })],
    [`a ${TO_IPC} key`, () => ({ clientConfig: attack(), [TO_IPC]: 'x' })],
    [
      `a Map with a ${TO_IPC} key`,
      () =>
        new Map<string, unknown>([
          ['clientConfig', attack()],
          [TO_IPC, 'x'],
        ]),
    ],
  ])(
    'refuses a payload with %s, which the frame couldn’t encrypt, instead of hanging',
    (_name, payload) => {
      const { payload: sent } = hook(structuredClone(message(payload())))
      expect(sent).toEqual({ clientConfig: REFUSED })
      expect(() => encrypted(sent)).not.toThrow()
    },
  )

  it('keeps only the request fields FXM uses, whatever a later plugin release adds', () => {
    const request = { ...ALLOWED, unixSocket: '/var/run/docker.sock', localAddress: '10.0.0.2' }
    expect(reachesFetch(message({ clientConfig: request }))).toEqual(ALLOWED)
  })

  it('leaves the rest of a message as it is', () => {
    const sent: IpcMessage = {
      ...message(null, 'plugin:__TAURI_CHANNEL__|fetch'),
      options: { headers: { 'Tauri-Channel-Id': '9' } },
    }
    expect(hook(structuredClone(sent))).toEqual(sent)
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

  it('leaves what FXM’s own requests send as it is, with the Origin last', () => {
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
})

describe('what this file copies from Tauri', () => {
  it('comes from the releases in Cargo.lock', () => {
    // On other releases, compare what COPIED_FROM names with this file and the hook, adjust both
    // to any change, then update COPIED_FROM (see "Tauri updates" in the app's README).
    const lock = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8')
    for (const [crate, version] of Object.entries(COPIED_FROM)) {
      const locked = new RegExp(`^name = "${crate}"\\nversion = "([^"]+)"$`, 'm').exec(lock)?.[1]
      expect(locked, crate).toBe(version)
    }
  })
})
