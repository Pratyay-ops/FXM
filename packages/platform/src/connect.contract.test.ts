/**
 * Contract test: the web app's FXM Connect client against the extension's own content script
 * and message validation from apps/extension, on a happy-dom page. If either side changes the
 * protocol, this fails.
 */
import { isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { FEATURES, SPOTIFY_LOGIN_FEATURE } from '../../../apps/extension/src/config.ts'
import {
  type ContentScriptOptions,
  startContentScript,
} from '../../../apps/extension/src/content-script.ts'
import {
  type BridgeRequest,
  MESSAGE,
  parseBridgeRequest,
  SPOTIFY_TOKEN_PARAMS,
} from '../../../apps/extension/src/messages.ts'
import {
  CONNECT_ERROR_CODES,
  CONNECT_MESSAGE,
  ConnectBridgeError,
  type ConnectWindow,
  createConnectClient,
  SPOTIFY_TOKEN_PARAM_FORMS,
} from './connect'
import { memoryStorage } from './storage'

const ORIGIN = 'https://fxmusic.pages.dev'
const windows: { happyDOM: { close(): Promise<void> } }[] = []

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()))
})

/** A page with the real content script and a fake background behind it. */
function pageWithExtension(
  options: { login?: boolean; reply?: (request: BridgeRequest) => unknown } = {},
) {
  const window = new Window({ url: `${ORIGIN}/app/` })
  windows.push(window)
  const received: BridgeRequest[] = []
  const runtime = {
    async sendMessage(message: unknown) {
      if ((message as { type?: unknown }).type === MESSAGE.loginStatus) {
        return { type: MESSAGE.loginStatus, enabled: options.login === true }
      }
      // The background validates every request again before it acts on it.
      const parsed = parseBridgeRequest(message)
      if (!parsed.ok) return { type: MESSAGE.error, id: parsed.id, code: parsed.code }
      received.push(parsed.value)
      return (
        options.reply?.(parsed.value) ?? {
          type: MESSAGE.error,
          id: parsed.value.id,
          code: 'internal',
        }
      )
    },
  }
  const started = startContentScript({
    window: window as unknown as ContentScriptOptions['window'],
    document: window.document as unknown as ContentScriptOptions['document'],
    runtime,
    origins: [ORIGIN],
    version: '0.1.0',
  })
  expect(started).toBe(true)
  const client = createConnectClient({
    window: window as unknown as ConnectWindow,
    storage: memoryStorage(),
  })
  return { client, received }
}

describe('the FXM Connect protocol', () => {
  it('uses the extension’s message types', () => {
    for (const [name, type] of Object.entries(CONNECT_MESSAGE)) {
      expect(MESSAGE[name as keyof typeof MESSAGE]).toBe(type)
    }
  })

  it('accepts exactly the token parameters the extension forwards, in the same forms', () => {
    expect(Object.keys(SPOTIFY_TOKEN_PARAM_FORMS).sort()).toEqual(
      Object.keys(SPOTIFY_TOKEN_PARAMS).sort(),
    )
    for (const [name, form] of Object.entries(SPOTIFY_TOKEN_PARAM_FORMS)) {
      expect(form.source).toBe(
        SPOTIFY_TOKEN_PARAMS[name as keyof typeof SPOTIFY_TOKEN_PARAMS].source,
      )
    }
  })

  it('knows every error code the extension documents', () => {
    expect(CONNECT_ERROR_CODES).toEqual([
      'bad-request',
      'unsupported',
      'login-disabled',
      'private-tab',
      'rate-limited',
      'network-error',
      'timeout',
      'too-large',
      'unavailable',
      'internal',
    ])
  })
})

describe('the client with the real content script', () => {
  it('detects the extension with its version and features', async () => {
    const { client } = pageWithExtension()
    await expect(client.detect()).resolves.toEqual({
      state: 'present',
      version: '0.1.0',
      features: [...FEATURES],
    })
  })

  it('sees the Spotify login feature once the user turned it on', async () => {
    const { client } = pageWithExtension({ login: true })
    expect((await client.detect()).features).toEqual([...FEATURES, SPOTIFY_LOGIN_FEATURE])
  })

  it('sends token requests the extension accepts, and gets the relayed response', async () => {
    const { client, received } = pageWithExtension({
      login: true,
      reply: (request) => ({
        type: MESSAGE.response,
        id: request.id,
        status: 200,
        json: { accessToken: 'token', isAnonymous: false },
      }),
    })
    await client.detect()
    const params = { reason: 'init', productType: 'web-player', totp: '123456', totpVer: '61' }
    await expect(client.spotifyToken(params)).resolves.toEqual({
      status: 200,
      json: { accessToken: 'token', isAnonymous: false },
    })
    expect(received).toEqual([{ type: MESSAGE.spotifyToken, id: expect.any(String), params }])
  })

  it('sends server-time requests the extension accepts', async () => {
    const { client, received } = pageWithExtension({
      reply: (request) => ({
        type: MESSAGE.response,
        id: request.id,
        status: 200,
        json: { serverTime: 1 },
      }),
    })
    await client.detect()
    await expect(client.spotifyServerTime()).resolves.toEqual({
      status: 200,
      json: { serverTime: 1 },
    })
    expect(received).toEqual([{ type: MESSAGE.spotifyServerTime, id: expect.any(String) }])
  })

  it('maps the extension’s refusal to a typed error', async () => {
    const { client } = pageWithExtension({
      reply: (request) => ({ type: MESSAGE.error, id: request.id, code: 'login-disabled' }),
    })
    await client.detect()
    let error: unknown
    try {
      await client.spotifyToken({ reason: 'init' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConnectBridgeError)
    expect(isFxmError(error, 'AuthRequired')).toBe(true)
  })
})
