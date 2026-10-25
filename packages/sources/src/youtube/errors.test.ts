import { type EntityId, type FxmErrorCode, formatId, isFxmError, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { botCheckIn, httpError, isBotCheckPage, parseRetryAfter, requestFailure } from './errors'
import albumNotFound from './fixtures/album-not-found.json'
import nextNotFound from './fixtures/next-not-found.json'
import { context, fakeInnerTube, json, NONE, on, SIMPLE } from './fixtures/testing'
import { createYouTubeMusicProvider } from './music'
import { createYouTubeSession } from './session'
import { createYouTubeVideoProvider } from './video'

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)
const entity = { what: 'browse MPREb_x', entity: true }
const list = { what: 'search "x"', entity: false }

type FailedKind = 'entity' | 'list'

/** An InnerTube error body with a status, as YouTube writes them. */
const failed = (status: string, message = 'Request contains an invalid argument.') =>
  JSON.stringify({ error: { code: 400, message, status } })

describe('Retry-After', () => {
  it('reads delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000)
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0)
    expect(parseRetryAfter('Sun, 25 Oct 2026 12:00:30 GMT', NOW)).toBe(30_000)
    expect(parseRetryAfter('Sun, 25 Oct 2026 11:00:00 GMT', NOW)).toBe(0)
  })

  it('is unknown when absent or unreadable', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('soon', NOW)).toBeUndefined()
  })
})

describe('HTTP errors', () => {
  it.each<[number, string | null, string, FailedKind, FxmErrorCode]>([
    [429, '30', '{}', 'list', 'RateLimited'],
    [429, null, '<html>unusual traffic</html>', 'list', 'RateLimited'],
    [503, '5', '{}', 'list', 'RateLimited'],
    [503, null, '{}', 'list', 'Network'],
    [404, null, '{}', 'entity', 'NotFound'],
    [410, null, '{}', 'list', 'NotFound'],
    [400, null, failed('INVALID_ARGUMENT'), 'entity', 'NotFound'],
    [400, null, failed('INVALID_ARGUMENT'), 'list', 'Parse'],
    [400, null, failed('NOT_FOUND', 'Requested entity was not found.'), 'entity', 'NotFound'],
    [400, null, failed('NOT_FOUND', 'Requested entity was not found.'), 'list', 'NotFound'],
    [400, null, failed('FAILED_PRECONDITION', 'Precondition check failed.'), 'entity', 'Parse'],
    [400, null, '<html>Bad Request</html>', 'entity', 'Parse'],
    [401, null, '{}', 'list', 'AuthRequired'],
    [403, null, '{"error":{"status":"PERMISSION_DENIED"}}', 'list', 'Unsupported'],
    [403, null, "Sign in to confirm you're not a bot", 'list', 'BotCheck'],
    [500, null, 'oops', 'entity', 'Network'],
  ])('maps %i (Retry-After %s) to the right code', (status, retryAfter, body, kind, code) => {
    const error = httpError(status, retryAfter, body, kind === 'entity' ? entity : list, NOW)
    expect(error.code).toBe(code)
    expect(error.message).toContain(`HTTP ${status}`)
  })

  it('keeps the retry delay, InnerTube’s own message and its status', () => {
    const limited = httpError(429, '30', '{}', list, NOW)
    expect(limited.retryAfterMs).toBe(30_000)
    const invalid = httpError(400, null, failed('INVALID_ARGUMENT', 'Bad id.'), entity, NOW)
    expect(invalid.message).toBe(
      'YouTube answered browse MPREb_x with HTTP 400 (INVALID_ARGUMENT): Bad id.',
    )
    const outdated = httpError(400, null, failed('FAILED_PRECONDITION'), entity, NOW)
    expect(outdated.message).toContain('(FAILED_PRECONDITION)')
    const long = httpError(500, null, 'x'.repeat(1000), list, NOW)
    expect(long.message.length).toBeLessThan(250)
  })
})

describe('bot checks in successful answers', () => {
  it('finds "not a bot" texts wherever YouTube writes them, and a LOGIN_REQUIRED without a reason', () => {
    expect(botCheckIn({ playabilityStatus: { status: 'LOGIN_REQUIRED' } })).toBe('LOGIN_REQUIRED')
    expect(
      botCheckIn({
        playabilityStatus: {
          status: 'LOGIN_REQUIRED',
          reason: 'Sign in to confirm you’re not a bot',
        },
      }),
    ).toBe('Sign in to confirm you’re not a bot')
    expect(
      botCheckIn({
        playabilityStatus: { status: 'ERROR', reason: "Sign in to confirm you're not a bot" },
      }),
    ).toContain('not a bot')
    expect(
      botCheckIn({
        playabilityStatus: {
          status: 'LOGIN_REQUIRED',
          messages: ["This helps protect our community. Confirm you're not a bot"],
        },
      }),
    ).toContain('not a bot')
    expect(
      botCheckIn({
        playabilityStatus: {
          status: 'UNPLAYABLE',
          errorScreen: {
            playerErrorMessageRenderer: {
              subreason: { runs: [{ text: 'Sign in to confirm you’re not a bot' }] },
            },
          },
        },
      }),
    ).toContain('not a bot')
    expect(
      botCheckIn({
        alerts: [{ alertRenderer: { text: { runs: [{ text: "Confirm you're not a bot" }] } } }],
      }),
    ).toContain('not a bot')
    expect(
      botCheckIn({
        alerts: [{ alertWithButtonRenderer: { text: { simpleText: 'Unusual traffic' } } }],
      }),
    ).toBe('Unusual traffic')
  })

  it('leaves age gates and private videos to the caller', () => {
    for (const playabilityStatus of [
      {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm your age',
        desktopLegacyAgeGateReason: 1,
      },
      {
        status: 'LOGIN_REQUIRED',
        reason: 'This video may be inappropriate for some users.',
        reasonTitle: 'You must sign in to view this video',
      },
      { status: 'LOGIN_REQUIRED', desktopLegacyAgeGateReason: 1 },
      {
        status: 'LOGIN_REQUIRED',
        reason: 'This video is private',
        messages: ['This is a private video. Please sign in to verify that you may see it.'],
      },
    ]) {
      expect(botCheckIn({ playabilityStatus })).toBeUndefined()
    }
  })

  it('leaves ordinary answers alone', () => {
    expect(botCheckIn({ contents: {} })).toBeUndefined()
    expect(botCheckIn({ playabilityStatus: { status: 'OK' } })).toBeUndefined()
    expect(
      botCheckIn({ alerts: [{ alertRenderer: { text: { simpleText: 'Hi' } } }] }),
    ).toBeUndefined()
    expect(botCheckIn(null)).toBeUndefined()
  })

  it('recognizes Google’s HTML bot check page', () => {
    expect(isBotCheckPage('<html><body>Our systems have detected unusual traffic')).toBe(true)
    expect(isBotCheckPage('<html>Hello</html>')).toBe(false)
    expect(isBotCheckPage('{"unusual traffic": 1}')).toBe(false)
  })
})

describe('failed requests', () => {
  it('are Network errors, timeouts and aborts nobody asked for included', () => {
    const typeError = requestFailure(new TypeError('Failed to fetch'), 'search "x"')
    expect(typeError).toMatchObject({
      code: 'Network',
      message: 'The request for search "x" Failed to fetch',
    })
    for (const name of ['TimeoutError', 'AbortError']) {
      expect(requestFailure(new DOMException('slow', name), 'browse X')).toMatchObject({
        code: 'Network',
        message: 'The request for browse X timed out',
      })
    }
    const known = httpError(404, null, '', entity)
    expect(requestFailure(known, 'x')).toBe(known)
  })

  it('stay the caller’s cancellation when the caller aborted', () => {
    const controller = new AbortController()
    controller.abort('user')
    expect(requestFailure(new TypeError('x'), 'x', controller.signal)).toBe('user')
    const abort = new DOMException('stop', 'AbortError')
    expect(requestFailure(abort, 'x', controller.signal)).toBe('user')
  })
})

describe('errors through the providers', () => {
  const music = createYouTubeMusicProvider()
  const search = (fetch: typeof globalThis.fetch, extra: Parameters<typeof context>[1] = {}) =>
    music.search(
      'Radiohead',
      { types: ['track'] },
      context(fetch, { capabilities: SIMPLE, ...extra }),
    )

  it('fail fast with Unsupported where YouTube is unreachable, before any request', async () => {
    const youtube = fakeInnerTube()
    const video = createYouTubeVideoProvider()
    const plain = context(youtube.fetch, { capabilities: NONE })
    const id = formatId('ytm', 'track', 'dQw4w9WgXcQ')
    for (const call of [
      music.search('x', { types: ['track'] }, plain),
      music.getTrack(id, plain),
      music.radio({ name: 'x' }, plain),
      music.suggest('x', plain),
      music.topResult('x', plain),
      music.getDescription(id, plain),
      video.search('x', { types: ['video'] }, plain),
      video.getAlbum(formatId('yt', 'album', 'MPREb_x'), plain),
    ]) {
      await expect(call).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
    }
    expect(youtube.requests).toEqual([])
  })

  it('rate limits with the Retry-After delay', async () => {
    const youtube = fakeInnerTube(
      on('search', {}, { error: { code: 429 } }, { status: 429, headers: { 'Retry-After': '17' } }),
    )
    await expect(search(youtube.fetch)).rejects.toMatchObject({
      name: 'FxmError',
      code: 'RateLimited',
      retryAfterMs: 17_000,
    })
  })

  it('bot checks: LOGIN_REQUIRED, the HTML page, a 403 that says so', async () => {
    for (const route of [
      on('search', {}, { playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
      () =>
        new Response('<html>unusual traffic from your computer network</html>', { status: 200 }),
      () => new Response("<p>Sign in to confirm you're not a bot</p>", { status: 403 }),
    ]) {
      const youtube = fakeInnerTube(route)
      await expect(search(youtube.fetch)).rejects.toSatisfy((error) =>
        isFxmError(error, 'BotCheck'),
      )
    }
  })

  it('not found: an unknown album, an unknown video, a malformed ID, a refused ID', async () => {
    const youtube = fakeInnerTube(
      on('browse', { browseId: 'MPREb_0000000000a' }, albumNotFound),
      on('next', { videoId: 'aaaaaaaaaaa' }, nextNotFound),
      on(
        'browse',
        { browseId: 'MPREb_refused' },
        { error: { status: 'INVALID_ARGUMENT' } },
        {
          status: 400,
        },
      ),
    )
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    for (const call of [
      music.getAlbum(formatId('ytm', 'album', 'MPREb_0000000000a'), ctx),
      music.getTrack(formatId('ytm', 'track', 'aaaaaaaaaaa'), ctx),
      music.getTrack(formatId('ytm', 'track', 'too-short'), ctx),
      music.getAlbum(formatId('ytm', 'album', 'MPREb_refused'), ctx),
    ]) {
      await expect(call).rejects.toSatisfy((error) => isFxmError(error, 'NotFound'))
    }
    expect(youtube.requests).toHaveLength(3)
  })

  it('unsupported: another source’s ID, another kind, plain YouTube’s albums', async () => {
    const youtube = fakeInnerTube()
    const video = createYouTubeVideoProvider()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    for (const call of [
      music.getAlbum(formatId('spotify', 'album', '4aawyAB9vmqN3uQ7FjRGTy'), ctx),
      music.getTrack(
        formatId('ytm', 'album', 'MPREb_DciERiuADkS') as EntityId as EntityId<'track'>,
        ctx,
      ),
      music.getPlaylist(formatId('spotify', 'playlist', '37i9dQZF1DXcBWIGoYBM5M'), ctx),
      video.getAlbum(formatId('yt', 'album', 'MPREb_DciERiuADkS'), ctx),
      video.getAlbum(formatId('ytm', 'album', 'MPREb_DciERiuADkS'), ctx),
    ]) {
      await expect(call).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
    }
    expect(youtube.requests).toEqual([])
  })

  it('an outdated config: a 400 that refuses the request rather than the entity', async () => {
    const youtube = fakeInnerTube(
      on(
        'next',
        {},
        { error: { message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } },
        { status: 400 },
      ),
    )
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    await expect(music.getTrack(formatId('ytm', 'track', 'zFYEYRcjK2g'), ctx)).rejects.toSatisfy(
      (error) => isFxmError(error, 'Parse'),
    )
    const radio = fakeInnerTube(
      on('next', {}, { error: { status: 'INVALID_ARGUMENT' } }, { status: 400 }),
    )
    const song: Track = {
      id: formatId('ytm', 'track', 'zFYEYRcjK2g'),
      source: 'ytm',
      title: 'Creep',
      artists: [],
      artwork: [],
      kind: 'song',
    }
    await expect(
      music.radio(song, context(radio.fetch, { capabilities: SIMPLE })),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Parse'))
  })

  it('parse errors: not JSON, an unexpected shape', async () => {
    for (const route of [
      () => new Response('{"broken', { status: 200 }),
      on('search', {}, { contents: { somethingElse: {} } }),
    ]) {
      const youtube = fakeInnerTube(route)
      await expect(search(youtube.fetch)).rejects.toSatisfy((error) => isFxmError(error, 'Parse'))
    }
  })

  it('network errors and timeouts, while the caller’s cancellation stays an AbortError', async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(search(offline)).rejects.toSatisfy((error) => isFxmError(error, 'Network'))
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const slow = createYouTubeMusicProvider({ timeoutMs: 10 })
    await expect(
      slow.search('x', { types: ['track'] }, context(hanging, { capabilities: SIMPLE })),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Network'))
    const controller = new AbortController()
    const pending = search(hanging, { signal: controller.signal })
    controller.abort(new DOMException('stop', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('times out even when the transport ignores the abort, or aborts with a bare AbortError', async () => {
    const deaf: typeof fetch = () => new Promise(() => {})
    const slow = createYouTubeMusicProvider({ timeoutMs: 10 })
    const ctx = context(deaf, { capabilities: SIMPLE })
    await expect(slow.search('x', { types: ['track'] }, ctx)).rejects.toMatchObject({
      code: 'Network',
      message: expect.stringContaining('timed out'),
    })
    const bare: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        )
      })
    await expect(
      slow.search('x', { types: ['track'] }, context(bare, { capabilities: SIMPLE })),
    ).rejects.toMatchObject({ code: 'Network', message: expect.stringContaining('timed out') })
  })

  it('other statuses keep their meaning', async () => {
    const youtube = fakeInnerTube(on('search', {}, { error: {} }, { status: 500 }))
    await expect(search(youtube.fetch)).rejects.toSatisfy((error) => isFxmError(error, 'Network'))
    const refused = fakeInnerTube(
      on('search', {}, { error: { status: 'PERMISSION_DENIED' } }, { status: 403 }),
    )
    await expect(search(refused.fetch)).rejects.toSatisfy((error) =>
      isFxmError(error, 'Unsupported'),
    )
  })
})

describe('LOGIN_REQUIRED from the player', () => {
  const ISSUED = 'CgtJc3N1ZWRCeVlUKIiIiIiIiIiIAQ'
  /** A `player` answer with this playability status, after a request that went with ISSUED. */
  const player = (playabilityStatus: Record<string, unknown>) =>
    json({
      responseContext: {},
      playabilityStatus,
      videoDetails: { videoId: 'HtVdAasjOgU', title: 'A trailer', lengthSeconds: '142' },
    })

  async function ask(playabilityStatus: Record<string, unknown>) {
    const session = createYouTubeSession({
      visitorDataStore: { load: () => ISSUED, save: () => {}, clear: () => {} },
    })
    const youtube = fakeInnerTube((request) =>
      request.url.pathname === '/youtubei/v1/player' ? player(playabilityStatus) : undefined,
    )
    const innertube = await session.innertube(context(youtube.fetch, { capabilities: SIMPLE }))
    const outcome = await innertube.actions
      .execute('/player', { videoId: 'HtVdAasjOgU', client: 'YTMUSIC' })
      .then(
        (response) => ({ data: response.data as { playabilityStatus?: unknown } }),
        (error: unknown) => ({ error }),
      )
    return { outcome, session, sent: youtube.requests[0]?.rawBody ?? '' }
  }

  it('an age gate comes back to the caller, and the session keeps its visitorData', async () => {
    const { outcome, session, sent } = await ask({
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm your age',
      desktopLegacyAgeGateReason: 1,
    })
    expect(sent).toContain(ISSUED)
    expect(outcome).toMatchObject({
      data: { playabilityStatus: { reason: 'Sign in to confirm your age' } },
    })
    expect(session.visitorData.current).toBe(ISSUED)
  })

  it('so does a private video', async () => {
    const { outcome, session } = await ask({
      status: 'LOGIN_REQUIRED',
      reason: 'This video is private',
    })
    expect(outcome).toHaveProperty('data')
    expect(session.visitorData.current).toBe(ISSUED)
  })

  it('a bot check rejects with BotCheck and drops the visitorData', async () => {
    const { outcome, session } = await ask({
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm you’re not a bot',
    })
    expect(outcome).toMatchObject({ error: { name: 'FxmError', code: 'BotCheck' } })
    expect(session.visitorData.current).toBeUndefined()
  })
})
