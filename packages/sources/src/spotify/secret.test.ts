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
import {
  checkSpotifySecretSource,
  createSpotifySecretProvider,
  deriveSpotifyTotpKey,
  parseSpotifySecretJson,
  parseSpotifySecretSource,
} from './secret'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OTHER_URL = 'https://mirror.example.test/secret.json'

describe('parseSpotifySecretJson', () => {
  const codes = FAKE_SECRET.secret
  const text = String.fromCharCode(...codes)

  it('reads the map shape and picks the newest version', () => {
    expect(parseSpotifySecretJson({ '5': [1, 2, 3], '7': codes, '6': [4, 5] })).toEqual({
      version: 7,
      secret: codes,
    })
  })

  it('reads lists of entries with numbers or text, in any order', () => {
    expect(
      parseSpotifySecretJson([
        { version: 7, secret: codes },
        { version: 3, secret: [9] },
      ]),
    ).toEqual({ version: 7, secret: codes })
    expect(parseSpotifySecretJson([{ secret: text, version: 7 }])).toEqual({
      version: 7,
      secret: codes,
    })
  })

  it('reads a single pasted entry', () => {
    expect(parseSpotifySecretJson({ version: 7, secret: text })).toEqual({
      version: 7,
      secret: codes,
    })
  })

  it('skips malformed entries', () => {
    expect(
      parseSpotifySecretJson([
        { version: 9, secret: [] },
        { version: 'x', secret: [1] },
        { version: 8, secret: [1.5] },
        { version: 7, secret: codes },
        'junk',
      ]),
    ).toEqual({ version: 7, secret: codes })
  })

  it('skips versions FXM Connect would not forward, and oversized secrets', () => {
    const long = new Array<number>(257).fill(65)
    expect(
      parseSpotifySecretJson({
        '10000': codes,
        '99999999': codes,
        '8': long,
        '7': codes,
      }),
    ).toEqual({ version: 7, secret: codes })
    expect(
      parseSpotifySecretJson([
        { version: 12_345, secret: codes },
        { version: 9999, secret: codes },
      ]),
    ).toEqual({ version: 9999, secret: codes })
    expect(parseSpotifySecretJson({ version: 2, secret: 'x'.repeat(256) }).secret).toHaveLength(256)
    expect(() => parseSpotifySecretJson({ version: 2, secret: 'x'.repeat(257) })).toThrow()
  })

  it('fails without leaking anything when there is no usable secret', () => {
    for (const value of [null, 'text', 42, [], {}, { '0': [1] }, [{ version: 1 }]]) {
      let error: unknown
      try {
        parseSpotifySecretJson(value)
      } catch (e) {
        error = e
      }
      expect(isSpotifyError(error, 'secret-unavailable')).toBe(true)
    }
  })
})

describe('deriveSpotifyTotpKey', () => {
  const decode = (key: Uint8Array) => new TextDecoder().decode(key)

  it('XORs each number with (index mod 33) + 9 and joins the results in decimal', () => {
    expect(decode(deriveSpotifyTotpKey([9, 10, 11, 12]))).toBe('0000')
    expect(decode(deriveSpotifyTotpKey([10, 11]))).toBe('31')
    const zeros = new Array<number>(34).fill(0)
    const expected = `${Array.from({ length: 33 }, (_, i) => i + 9).join('')}9`
    expect(decode(deriveSpotifyTotpKey(zeros))).toBe(expected)
  })
})

describe('secret sources', () => {
  it('turns what the user typed into a checked source', () => {
    expect(parseSpotifySecretSource(` ${OTHER_URL} `)).toEqual({ url: OTHER_URL })
    const pasted = JSON.stringify(FAKE_SECRET_JSON)
    expect(parseSpotifySecretSource(pasted)).toEqual({ json: pasted })
    expect(parseSpotifySecretSource(`[{"version":3,"secret":"abc"}]`)).toEqual({
      json: '[{"version":3,"secret":"abc"}]',
    })
  })

  it('refuses URLs that are not https on a public host, and unusable JSON', () => {
    const refused: Array<[string, RegExp]> = [
      ['', /Enter a URL/u],
      ['http://secrets.example.test/s.json', /https/u],
      ['data:application/json,{}', /https/u],
      ['https://user:pass@secrets.example.test/s.json', /user name or password/u],
      ['https://192.168.1.1/router-admin.json', /public host/u],
      ['https://localhost:8080/s.json', /public host/u],
      ['secret please', /not a URL/u],
      ['{"nothing": "here"}', /no usable secret/u],
      ['{not json', /not JSON/u],
      [`{"7": [${new Array(40_000).fill(1).join(',')}]}`, /too long/u],
    ]
    for (const [text, message] of refused) {
      expect(() => parseSpotifySecretSource(text), text.slice(0, 40)).toThrow(message)
    }
    expect(() => checkSpotifySecretSource({ nope: 1 } as never)).toThrow(TypeError)
  })

  it('checks sources when they are set, not on the next mint', () => {
    expect(() => createSpotifySecretProvider({ sources: [{ url: 'http://x.test/s' }] })).toThrow(
      TypeError,
    )
    const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
    expect(() => secrets.setSources([{ url: 'https://127.0.0.1/s' }])).toThrow(/public host/u)
  })
})

describe('createSpotifySecretProvider', () => {
  it('fetches the secret from a URL, without credentials, and caches it for its TTL', async () => {
    const clock = fakeClock()
    const spotify = fakeSpotify({ clock })
    const secrets = createSpotifySecretProvider({
      sources: [{ url: SECRET_URL }],
      now: clock.now,
      ttlMs: HOUR,
    })
    const ctx = contextFor(spotify.fetch)
    const first = await secrets.get(ctx)
    expect(first.version).toBe(FAKE_SECRET.version)
    expect(first.key).toEqual(deriveSpotifyTotpKey(FAKE_SECRET.secret))
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
    const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
    const ctx = contextFor(spotify.fetch)
    await Promise.all([secrets.get(ctx), secrets.get(ctx), secrets.get(ctx)])
    expect(spotify.callsOf('secret')).toHaveLength(1)
    await secrets.get(ctx, { refresh: true })
    expect(spotify.callsOf('secret')).toHaveLength(2)
  })

  it('uses pasted JSON and falls through to the next source on failure', async () => {
    const spotify = fakeSpotify({ secret: () => json({ nothing: 'here' }) })
    const secrets = createSpotifySecretProvider({
      sources: [{ url: SECRET_URL }, { json: JSON.stringify(FAKE_SECRET_JSON) }],
    })
    expect((await secrets.get(contextFor(spotify.fetch))).version).toBe(FAKE_SECRET.version)
  })

  it('prefers an injected fetch for URL sources', async () => {
    const spotify = fakeSpotify()
    const unused = fakeSpotify()
    const secrets = createSpotifySecretProvider({
      sources: [{ url: SECRET_URL }],
      fetch: spotify.fetch,
    })
    await secrets.get(contextFor(unused.fetch))
    expect(spotify.callsOf('secret')).toHaveLength(1)
    expect(unused.calls).toHaveLength(0)
  })

  it('keeps the last good secret when a reload after its lifetime fails, and retries later', async () => {
    const clock = fakeClock()
    let down = false
    const spotify = fakeSpotify({
      clock,
      secret: () => (down ? json({}, { status: 503 }) : json(FAKE_SECRET_JSON)),
    })
    const secrets = createSpotifySecretProvider({
      sources: [{ url: SECRET_URL }],
      now: clock.now,
      ttlMs: HOUR,
      retryMs: 5 * MINUTE,
    })
    const ctx = contextFor(spotify.fetch)
    const good = await secrets.get(ctx)
    down = true
    clock.advance(HOUR)
    // The source is down: the stale secret keeps working, and the source is asked once.
    expect(await secrets.get(ctx)).toBe(good)
    expect(await secrets.get(ctx)).toBe(good)
    expect(await secrets.get(ctx)).toBe(good)
    expect(spotify.callsOf('secret')).toHaveLength(2)
    clock.advance(5 * MINUTE)
    expect(await secrets.get(ctx)).toBe(good)
    expect(spotify.callsOf('secret')).toHaveLength(3)
    // A refresh (after Spotify refused a TOTP) never falls back to the stale secret.
    await expect(secrets.get(ctx, { refresh: true })).rejects.toMatchObject({
      reason: 'secret-unavailable',
    })
    down = false
    clock.advance(5 * MINUTE)
    expect((await secrets.get(ctx)).version).toBe(FAKE_SECRET.version)
    expect(spotify.callsOf('secret')).toHaveLength(5)
  })

  it('skips a source that still serves the refused secret', async () => {
    const stale = fakeSpotify({ secret: () => json({ '6': [1, 2, 3] }) })
    const secrets = createSpotifySecretProvider({
      sources: [{ url: SECRET_URL }, { json: JSON.stringify(FAKE_SECRET_JSON) }],
      fetch: stale.fetch,
    })
    const ctx = contextFor(stale.fetch)
    const refused = await secrets.get(ctx)
    expect(refused.version).toBe(6)
    const next = await secrets.get(ctx, { refresh: true, refused })
    expect(next.version).toBe(FAKE_SECRET.version)
    // The new secret is cached.
    expect(await secrets.get(ctx)).toBe(next)
  })

  it('says when every source still serves the refused secret', async () => {
    const spotify = fakeSpotify()
    const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
    const ctx = contextFor(spotify.fetch)
    const refused = await secrets.get(ctx)
    const error = await secrets.get(ctx, { refresh: true, refused }).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'secret-rejected')).toBe(true)
    expect((error as Error).message).toMatch(/still serves the refused secret/u)
    // The refused secret is not kept: the next call asks the source again.
    await secrets.get(ctx)
    expect(spotify.callsOf('secret')).toHaveLength(3)
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
      [
        'a declared oversized body',
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(10 * 1024 * 1024) },
          }),
        /more than 64 KiB/u,
      ],
      [
        'an oversized body without a length',
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const chunk = new TextEncoder().encode(' '.repeat(16 * 1024))
                for (let i = 0; i < 8; i++) controller.enqueue(chunk)
                controller.close()
              },
            }),
            { status: 200 },
          ),
        /more than 64 KiB/u,
      ],
    ]

    for (const [name, answer, message] of failures) {
      it(`reports ${name} as secret-unavailable, without the secret or a query`, async () => {
        const spotify = fakeSpotify({ secret: answer })
        const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
        const error = await secrets.get(contextFor(spotify.fetch)).catch((e: unknown) => e)
        expect(isSpotifyError(error, 'secret-unavailable')).toBe(true)
        expect((error as Error).message).toMatch(message)
        expect((error as Error).message).not.toMatch(/\?a=1/u)
      })
    }

    it('reports a missing source list', async () => {
      const ctx = contextFor(fakeSpotify().fetch)
      const none = createSpotifySecretProvider({ sources: [] })
      await expect(none.get(ctx)).rejects.toThrow(/no source is configured/u)
    })

    it('times out a source that never answers', async () => {
      const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }], timeoutMs: 5 })
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      await expect(secrets.get(contextFor(hanging))).rejects.toThrow(/timed out/u)
    })

    it('passes a caller abort through unchanged', async () => {
      const controller = new AbortController()
      controller.abort(new DOMException('stop', 'AbortError'))
      const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
      const ctx = contextFor(fakeSpotify().fetch, { signal: controller.signal })
      await expect(secrets.get(ctx)).rejects.toMatchObject({ name: 'AbortError' })
    })
  })

  it('forgets the cached secret when the sources change or on clear', async () => {
    const spotify = fakeSpotify()
    const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
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
    const secrets = createSpotifySecretProvider({ sources: [{ url: SECRET_URL }] })
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
