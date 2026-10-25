import { describe, expect, it } from 'vitest'
import {
  isBridgeReply,
  isLoginStatus,
  MESSAGE,
  type MessageEventLike,
  messageType,
  parseBridgeRequest,
  parseRequestId,
  parseTokenParams,
  readPageMessage,
} from './messages.ts'

const ORIGIN = 'https://fxm-music.pages.dev'
const pageWindow = { name: 'page' }
const expected = { source: pageWindow, origin: ORIGIN }

function event(data: unknown, overrides: Partial<MessageEventLike> = {}): MessageEventLike {
  return { source: pageWindow, origin: ORIGIN, data, ...overrides }
}

const VALID_PARAMS = {
  reason: 'init',
  productType: 'web-player',
  totp: '123456',
  totpServer: '654321',
  totpVer: '5',
}

describe('readPageMessage: who may talk to FXM Connect', () => {
  it('ignores messages from another window, such as an iframe or an opener', () => {
    expect(readPageMessage(event({ type: MESSAGE.ping }, { source: {} }), expected)).toBeNull()
    expect(readPageMessage(event({ type: MESSAGE.ping }, { source: null }), expected)).toBeNull()
  })

  it('ignores messages whose origin is not the FXM page', () => {
    for (const origin of ['https://evil.example', 'https://fxm-music.pages.dev.evil.example']) {
      expect(readPageMessage(event({ type: MESSAGE.ping }, { origin }), expected)).toBeNull()
    }
  })

  it('ignores messages that are not FXM Connect requests', () => {
    for (const data of [null, 'fxm-connect:ping', 42, [MESSAGE.ping], { type: 'other' }, {}]) {
      expect(readPageMessage(event(data), expected)).toBeNull()
    }
  })

  it('ignores its own replies', () => {
    for (const type of [MESSAGE.pong, MESSAGE.response, MESSAGE.error]) {
      expect(readPageMessage(event({ type, id: 1 }), expected)).toBeNull()
    }
  })
})

describe('readPageMessage: requests', () => {
  it('accepts a ping', () => {
    expect(readPageMessage(event({ type: MESSAGE.ping }), expected)).toEqual({ kind: 'ping' })
  })

  it('accepts a token request with allow-listed parameters', () => {
    const message = { type: MESSAGE.spotifyToken, id: 'req-1', params: VALID_PARAMS }
    expect(readPageMessage(event(message), expected)).toEqual({ kind: 'bridge', request: message })
  })

  it('accepts a server-time request', () => {
    const message = { type: MESSAGE.spotifyServerTime, id: 7 }
    expect(readPageMessage(event(message), expected)).toEqual({ kind: 'bridge', request: message })
  })

  it('rejects unknown FXM Connect messages, including background-only ones', () => {
    for (const type of ['fxm-connect:fetch', MESSAGE.activateOrigin, MESSAGE.loginStatus]) {
      expect(readPageMessage(event({ type, id: 'x' }), expected)).toEqual({
        kind: 'reject',
        reply: { type: MESSAGE.error, id: 'x', code: 'unsupported' },
      })
    }
  })

  it('rejects malformed requests with bad-request, echoing a usable ID', () => {
    const message = { type: MESSAGE.spotifyToken, id: 3, params: { url: 'https://evil.example' } }
    expect(readPageMessage(event(message), expected)).toEqual({
      kind: 'reject',
      reply: { type: MESSAGE.error, id: 3, code: 'bad-request' },
    })
    expect(readPageMessage(event({ type: MESSAGE.spotifyServerTime }), expected)).toEqual({
      kind: 'reject',
      reply: { type: MESSAGE.error, id: null, code: 'bad-request' },
    })
  })
})

describe('parseTokenParams: the allow-list', () => {
  it('accepts any subset of the five parameters', () => {
    expect(parseTokenParams(VALID_PARAMS)).toEqual(VALID_PARAMS)
    expect(parseTokenParams({ reason: 'transport' })).toEqual({ reason: 'transport' })
    expect(parseTokenParams({})).toEqual({})
  })

  it.each([
    [{ url: 'https://evil.example/' }],
    [{ cookie: 'sp_dc=1' }],
    [{ reason: 'init', callback: 'x' }],
    [JSON.parse('{"__proto__": {"reason": "init"}}')],
    [{ constructor: 'x' }],
  ])('rejects unknown parameters: %j', (params) => {
    expect(parseTokenParams(params)).toBeNull()
  })

  it.each([
    ['reason', 'init&productType=x'],
    ['reason', ''],
    ['reason', 'a'.repeat(33)],
    ['productType', 'web player'],
    ['totp', '12345'],
    ['totp', '12345a'],
    ['totpServer', '-123456'],
    ['totpVer', '12345'],
    ['totpVer', 5],
    ['totp', 123456],
    ['reason', null],
    ['reason', ['init']],
  ])('rejects %s = %j', (name, value) => {
    expect(parseTokenParams({ [name]: value })).toBeNull()
  })

  it('rejects anything that is not a plain object', () => {
    for (const value of [null, undefined, 'reason=init', ['init'], 1]) {
      expect(parseTokenParams(value)).toBeNull()
    }
  })
})

describe('parseBridgeRequest', () => {
  it('rejects unexpected fields', () => {
    expect(
      parseBridgeRequest({ type: MESSAGE.spotifyToken, id: 1, params: {}, url: 'x' }),
    ).toMatchObject({ ok: false, code: 'bad-request' })
    expect(
      parseBridgeRequest({ type: MESSAGE.spotifyServerTime, id: 1, credentials: 'include' }),
    ).toMatchObject({ ok: false, code: 'bad-request' })
  })

  it('requires params on token requests', () => {
    expect(parseBridgeRequest({ type: MESSAGE.spotifyToken, id: 1 })).toEqual({
      ok: false,
      id: 1,
      code: 'bad-request',
    })
  })

  it('rejects non-objects and unknown types', () => {
    expect(parseBridgeRequest(null)).toEqual({ ok: false, id: null, code: 'bad-request' })
    expect(parseBridgeRequest({ type: MESSAGE.ping, id: 1 })).toEqual({
      ok: false,
      id: 1,
      code: 'unsupported',
    })
  })
})

describe('parseRequestId', () => {
  it('accepts short strings and non-negative safe integers', () => {
    expect(parseRequestId('a-1:b.c_d')).toBe('a-1:b.c_d')
    expect(parseRequestId(0)).toBe(0)
    expect(parseRequestId(2 ** 40)).toBe(2 ** 40)
  })

  it.each<unknown>(['', 'a'.repeat(65), 'has space', -1, 1.5, Number.NaN, 2 ** 60, null, {}])(
    'rejects %j',
    (id) => {
      expect(parseRequestId(id)).toBeNull()
    },
  )
})

describe('isLoginStatus', () => {
  it('accepts only a login status with a boolean', () => {
    expect(isLoginStatus({ type: MESSAGE.loginStatus, enabled: true })).toBe(true)
    expect(isLoginStatus({ type: MESSAGE.loginStatus, enabled: false })).toBe(true)
    for (const value of [
      { type: MESSAGE.loginStatus, enabled: 'true' },
      { type: MESSAGE.loginStatus },
      { type: MESSAGE.error, id: null, code: 'internal' },
      null,
      undefined,
    ]) {
      expect(isLoginStatus(value)).toBe(false)
    }
  })
})

describe('messageType', () => {
  it('reads the type of message objects only', () => {
    expect(messageType({ type: MESSAGE.ping })).toBe(MESSAGE.ping)
    expect(messageType('fxm-connect:ping')).toBeUndefined()
    expect(messageType(null)).toBeUndefined()
  })
})

describe('isBridgeReply', () => {
  it('accepts responses and errors for the same ID only', () => {
    expect(isBridgeReply({ type: MESSAGE.response, id: 1, status: 200, json: null }, 1)).toBe(true)
    expect(isBridgeReply({ type: MESSAGE.error, id: 1, code: 'timeout' }, 1)).toBe(true)
    expect(isBridgeReply({ type: MESSAGE.response, id: 2, status: 200, json: null }, 1)).toBe(false)
    expect(isBridgeReply({ type: MESSAGE.response, id: 1, status: '200', json: {} }, 1)).toBe(false)
    expect(isBridgeReply(undefined, 1)).toBe(false)
  })
})
