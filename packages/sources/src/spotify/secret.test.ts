import { describe, expect, it } from 'vitest'
import { isSpotifyError } from './errors'
import {
  contextFor,
  FAKE_SECRET,
  FAKE_SECRET_JSON,
  fakeClock,
  fakeSpotify,
  json,
  SECRET_URL,
} from './fixtures/testing'
import { createSecretProvider, deriveTotpKey, parseSecretJson } from './secret'

const HOUR = 3_600_000

describe('parseSecretJson', () => {
  const codes = FAKE_SECRET.secret
  const text = String.fromCharCode(...codes)

  it('reads the map shape and picks the newest version', () => {
    expect(parseSecretJson({ '5': [1, 2, 3], '7': codes, '6': [4, 5] })).toEqual({
      version: 7,
      secret: codes,
    })
  })

  it('reads lists of entries with numbers or text, in any order', () => {
    expect(
      parseSecretJson([
        { version: 7, secret: codes },
        { version: 3, secret: [9] },
      ]),
    ).toEqual({ version: 7, secret: codes })
    expect(parseSecretJson([{ secret: text, version: 7 }])).toEqual({ version: 7, secret: codes })
  })

  it('reads a single pasted entry', () => {
    expect(parseSecretJson({ version: 7, secret: text })).toEqual({ version: 7, secret: codes })
  })

  it('skips malformed entries', () => {
    expect(
      parseSecretJson([
        { version: 9, secret: [] },
        { version: 'x', secret: [1] },
        { version: 8, secret: [1.5] },
        { version: 7, secret: codes },
        'junk',
      ]),
    ).toEqual({ version: 7, secret: codes })
  })

  it('fails without leaking anything when there is no usable secret', () => {
    for (const value of [null, 'text', 42, [], {}, { '0': [1] }, [{ version: 1 }]]) {
      let error: unknown
      try {
        parseSecretJson(value)
      } catch (e) {
        error = e
      }
      expect(isSpotifyError(error, 'secret-unavailable')).toBe(true)
    }
  })
})

describe('deriveTotpKey', () => {
  const decode = (key: Uint8Array) => new TextDecoder().decode(key)

  it('XORs each number with (index mod 33) + 9 and joins the results in decimal', () => {
    expect(decode(deriveTotpKey([9, 10, 11, 12]))).toBe('0000')
    expect(decode(deriveTotpKey([10, 11]))).toBe('31')
    const zeros = new Array<number>(34).fill(0)
    const expected = `${Array.from({ length: 33 }, (_, i) => i + 9).join('')}9`
    expect(decode(deriveTotpKey(zeros))).toBe(expected)
  })
})

describe('createSecretProvider', () => {
  it('fetches the secret from a URL, without credentials, and caches it for its TTL', async () => {
    const clock = fakeClock()
    const spotify = fakeSpotify({ clock })
    const secrets = createSecretProvider({
      sources: [{ url: SECRET_URL }],
      now: clock.now,
      ttlMs: HOUR,
    })
    const ctx = contextFor(spotify.fetch)
    const first = await secrets.get(ctx)
    expect(first.version).toBe(FAKE_SECRET.version)
    expect(first.key).toEqual(deriveTotpKey(FAKE_SECRET.secret))
    expect(spotify.calls[0]?.init?.credentials).toBe('omit')
    clock.advance(HOUR - 1)
    await secrets.get(ctx)
    expect(spotify.callsOf('secret')).toHaveLength(1)
    clock.advance(1)
    await secrets.get(ctx)
    expect(spotify.callsOf('secret')).toHaveLength(2)
  })

  it('refetches on request and shares one load between concurrent callers', async () => {
    const spotify = fakeSpotify()
    const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }] })
    const ctx = contextFor(spotify.fetch)
    await Promise.all([secrets.get(ctx), secrets.get(ctx), secrets.get(ctx)])
    expect(spotify.callsOf('secret')).toHaveLength(1)
    await secrets.get(ctx, { refresh: true })
    expect(spotify.callsOf('secret')).toHaveLength(2)
  })

  it('uses pasted JSON and falls through to the next source on failure', async () => {
    const spotify = fakeSpotify({ secret: () => json({ nothing: 'here' }) })
    const secrets = createSecretProvider({
      sources: [{ url: SECRET_URL }, { json: JSON.stringify(FAKE_SECRET_JSON) }],
    })
    expect((await secrets.get(contextFor(spotify.fetch))).version).toBe(FAKE_SECRET.version)
  })

  it('prefers an injected fetch for URL sources', async () => {
    const spotify = fakeSpotify()
    const unused = fakeSpotify()
    const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }], fetch: spotify.fetch })
    await secrets.get(contextFor(unused.fetch))
    expect(spotify.callsOf('secret')).toHaveLength(1)
    expect(unused.calls).toHaveLength(0)
  })

  describe('failures', () => {
    const failures: Array<[string, () => Response | Promise<Response>, RegExp]> = [
      ['a missing secret', () => json({}), /holds no secret/u],
      ['malformed JSON', () => new Response('{not json', { status: 200 }), /did not send JSON/u],
      ['an HTTP error', () => json({ message: 'gone' }, { status: 404 }), /HTTP 404/u],
      [
        'an unreachable URL',
        () => Promise.reject(new TypeError('fetch failed for https://secrets.example.test/x?a=1')),
        /unreachable/u,
      ],
    ]

    for (const [name, answer, message] of failures) {
      it(`reports ${name} as secret-unavailable, without the secret or a query`, async () => {
        const spotify = fakeSpotify({ secret: answer })
        const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }] })
        const error = await secrets.get(contextFor(spotify.fetch)).catch((e: unknown) => e)
        expect(isSpotifyError(error, 'secret-unavailable')).toBe(true)
        expect((error as Error).message).toMatch(message)
        expect((error as Error).message).not.toMatch(/\?a=1/u)
      })
    }

    it('reports pasted text that is not JSON, and a missing source list', async () => {
      const ctx = contextFor(fakeSpotify().fetch)
      const pasted = createSecretProvider({ sources: [{ json: 'secret please' }] })
      await expect(pasted.get(ctx)).rejects.toThrow(/not JSON/u)
      const none = createSecretProvider({ sources: [] })
      await expect(none.get(ctx)).rejects.toThrow(/no source is configured/u)
    })

    it('times out a source that never answers', async () => {
      const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }], timeoutMs: 5 })
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      await expect(secrets.get(contextFor(hanging))).rejects.toThrow(/timed out/u)
    })

    it('passes a caller abort through unchanged', async () => {
      const controller = new AbortController()
      controller.abort(new DOMException('stop', 'AbortError'))
      const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }] })
      const ctx = contextFor(fakeSpotify().fetch, { signal: controller.signal })
      await expect(secrets.get(ctx)).rejects.toMatchObject({ name: 'AbortError' })
    })
  })

  it('forgets the cached secret when the sources change or on clear', async () => {
    const spotify = fakeSpotify()
    const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }] })
    const ctx = contextFor(spotify.fetch)
    await secrets.get(ctx)
    secrets.clear()
    await secrets.get(ctx)
    expect(spotify.callsOf('secret')).toHaveLength(2)
    secrets.setSources([{ json: JSON.stringify({ '9': [1, 2, 3] }) }])
    expect((await secrets.get(ctx)).version).toBe(9)
    expect(spotify.callsOf('secret')).toHaveLength(2)
  })

  it('lets a caller load again when the caller it shared a load with aborts', async () => {
    let release: (() => void) | undefined
    const slow: typeof fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        release = () => resolve(json(FAKE_SECRET_JSON))
      })
    const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }] })
    const first = new AbortController()
    const a = secrets.get(contextFor(slow, { signal: first.signal }))
    const b = secrets.get(contextFor(slow))
    first.abort(new DOMException('stop', 'AbortError'))
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    await Promise.resolve()
    release?.()
    expect((await b).version).toBe(FAKE_SECRET.version)
  })
})
