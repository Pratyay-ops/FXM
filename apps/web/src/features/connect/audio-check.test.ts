import { describe, expect, it } from 'vitest'
import {
  AUDIO_CHECK_RANGE,
  AUDIO_CHECK_TIMEOUT_MS,
  type AudioCheckResult,
  audioCheckPending,
  audioCheckSkip,
  audioCheckUrl,
  describeAudioCheck,
  googleVideoHost,
  HARD_BLOCK_ADVICE,
  runAudioCheck,
  UPDATE_CONNECT_ADVICE,
} from './audio-check'
import { CONNECT_STATUS, DETECTING, readyConnection, TIER_CAPABILITIES } from './testing'

const HOST = 'rr3---sn-fake1.googlevideo.com'
const OTHER_HOST = 'rr5---sn-fake2.googlevideo.com'
const STREAM_URL = `https://${HOST}/videoplayback?expire=1&ip=203.0.113.7&sig=SECRET&lsig=SECRET2`

/** What one request answers: a response, a network error, or nothing until it is aborted. */
type Answer =
  | {
      readonly status?: number
      readonly type?: ResponseType
      readonly redirected?: boolean
      readonly url?: string
      /** The body: bytes, a body that fails, or one whose bytes never come. */
      readonly body?: 'bytes' | 'breaks' | 'stalls'
    }
  | 'network-error'
  | 'hangs'
  | 'ignores-abort'

interface Call {
  readonly url: string
  readonly init: RequestInit
}

function body(kind: 'bytes' | 'breaks' | 'stalls'): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (kind === 'bytes') {
        controller.enqueue(new Uint8Array(1024))
        controller.close()
      } else if (kind === 'breaks') {
        controller.error(new TypeError('network error'))
      }
    },
  })
}

/** A `fetch` that gives `answers` in order and records each request. */
function fakeFetch(...answers: Answer[]) {
  const calls: Call[] = []
  const send = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(input), init })
    const answer = answers[calls.length - 1]
    if (answer === undefined) throw new Error(`Unexpected request #${calls.length}`)
    if (answer === 'network-error') return Promise.reject(new TypeError('Failed to fetch'))
    if (answer === 'ignores-abort') return new Promise(() => {})
    if (answer === 'hangs') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }
    const status = answer.status ?? 206
    const type = answer.type ?? 'cors'
    const opaque = type === 'opaque' || type === 'opaqueredirect'
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: opaque ? 0 : status,
      type,
      redirected: answer.redirected ?? false,
      url: opaque ? '' : (answer.url ?? String(input)),
      body: opaque ? null : body(answer.body ?? 'bytes'),
    } as unknown as Response)
  }
  return { calls, fetch: send as typeof fetch }
}

async function check(...answers: Answer[]) {
  const fake = fakeFetch(...answers)
  const result = await runAudioCheck({ url: STREAM_URL, fetch: fake.fetch, timeoutMs: 30 })
  // Never more than two small reads of googlevideo.
  expect(fake.calls.length).toBeLessThanOrEqual(2)
  return { result, calls: fake.calls }
}

function headers(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>
}

describe('runAudioCheck', () => {
  it('finds the audio readable with one ranged CORS request', async () => {
    const { result, calls } = await check({ status: 206 })
    expect(result).toEqual({ kind: 'readable', host: HOST })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(STREAM_URL)
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      mode: 'cors',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    })
    expect(headers(calls[0])).toEqual({ Range: AUDIO_CHECK_RANGE })
    expect(AUDIO_CHECK_RANGE).toBe('bytes=0-1023')
  })

  it('finds it readable after a redirect, naming the host the redirect led to', async () => {
    const { result, calls } = await check(
      { type: 'opaqueredirect' },
      { status: 206, redirected: true, url: `https://${OTHER_HOST}/videoplayback?sig=SECRET` },
    )
    expect(result).toEqual({ kind: 'readable', host: HOST, redirectedTo: OTHER_HOST })
    expect(calls[1]?.init).toMatchObject({ mode: 'cors', redirect: 'follow' })
    expect(headers(calls[1])).toEqual({ Range: AUDIO_CHECK_RANGE })
  })

  it('reports a redirect whose answer the page could not read (opaqueredirect)', async () => {
    const { result, calls } = await check({ type: 'opaqueredirect' }, 'network-error')
    expect(result).toEqual({ kind: 'redirected', host: HOST })
    expect(calls).toHaveLength(2)
  })

  it('tells a refused answer (CORS) from an unreachable server with a no-cors request', async () => {
    const refused = await check('network-error', { type: 'opaque' })
    expect(refused.result).toEqual({ kind: 'refused', host: HOST })
    const noCors = refused.calls[1]
    expect(noCors?.init).toMatchObject({ mode: 'no-cors', credentials: 'omit', cache: 'no-store' })
    // Range isn't allowed in no-cors requests: this one stops once its headers arrive.
    expect(noCors?.init.headers).toBeUndefined()
    expect(noCors?.init.signal?.aborted).toBe(true)

    const unreachable = await check('network-error', 'network-error')
    expect(unreachable.result).toEqual({ kind: 'unreachable', host: HOST })
  })

  it('reports HTTP errors, also after a redirect', async () => {
    expect((await check({ status: 403 })).result).toEqual({
      kind: 'http-error',
      host: HOST,
      status: 403,
    })
    expect((await check({ status: 503 })).result).toEqual({
      kind: 'http-error',
      host: HOST,
      status: 503,
    })
    expect((await check({ type: 'opaqueredirect' }, { status: 404 })).result).toEqual({
      kind: 'http-error',
      host: HOST,
      status: 404,
    })
  })

  it('times out when the server takes too long, whether or not fetch heeds the abort', async () => {
    const timeout = { kind: 'timeout', host: HOST, timeoutMs: 30 }
    const hangs = await check('hangs')
    expect(hangs.result).toEqual(timeout)
    expect(hangs.calls[0]?.init.signal?.aborted).toBe(true)
    expect((await check('ignores-abort')).result).toEqual(timeout)
    // Headers in time, but no audio after them.
    expect((await check({ status: 206, body: 'stalls' })).result).toEqual(timeout)
    expect((await check({ type: 'opaqueredirect' }, 'hangs')).result).toEqual(timeout)
    expect((await check('network-error', 'hangs')).result).toEqual(timeout)
    expect(AUDIO_CHECK_TIMEOUT_MS).toBe(10_000)
  })

  it('counts an answer that breaks off before any audio as unreachable', async () => {
    expect((await check({ status: 206, body: 'breaks' })).result).toEqual({
      kind: 'unreachable',
      host: HOST,
    })
  })

  it('stops on request', async () => {
    const fake = fakeFetch('hangs')
    const controller = new AbortController()
    const running = runAudioCheck({ url: STREAM_URL, fetch: fake.fetch, signal: controller.signal })
    controller.abort()
    expect(await running).toEqual({ kind: 'cancelled' })

    const already = fakeFetch('hangs')
    expect(
      await runAudioCheck({ url: STREAM_URL, fetch: already.fetch, signal: controller.signal }),
    ).toEqual({ kind: 'cancelled' })
    expect(already.calls).toHaveLength(0)
  })

  it("doesn't test a stream that isn't on googlevideo", async () => {
    const fake = fakeFetch()
    for (const url of [
      'fake://good',
      'blob:https://fxmusic.pages.dev/1',
      'https://archive.org/x',
    ]) {
      expect(await runAudioCheck({ url, fetch: fake.fetch })).toEqual({
        kind: 'not-tested',
        reason: 'not-googlevideo',
      })
    }
    expect(fake.calls).toHaveLength(0)
  })
})

describe('googleVideoHost', () => {
  it('gives the host name of an https googlevideo URL only', () => {
    expect(googleVideoHost(STREAM_URL)).toBe(HOST)
    expect(googleVideoHost('https://RR1---SN-ABC.GOOGLEVIDEO.COM/videoplayback')).toBe(
      'rr1---sn-abc.googlevideo.com',
    )
    expect(googleVideoHost('http://rr1---sn-abc.googlevideo.com/videoplayback')).toBeUndefined()
    expect(googleVideoHost('https://203.0.113.7/videoplayback')).toBeUndefined()
    expect(googleVideoHost('https://googlevideo.com.example/videoplayback')).toBeUndefined()
    expect(googleVideoHost('not a url')).toBeUndefined()
  })
})

describe('audioCheckUrl', () => {
  it('takes the stream the self-test ended on', () => {
    expect(audioCheckUrl([])).toBeUndefined()
    expect(audioCheckUrl([{ option: { url: 'a' } }, { option: { url: 'b' } }])).toBe('b')
  })
})

describe('audioCheckSkip', () => {
  it('runs with FXM Connect in the Full tier, in a browser', () => {
    const full = readyConnection({
      capabilities: TIER_CAPABILITIES.full,
      connect: CONNECT_STATUS.present,
      lite: 'not-needed',
    })
    expect(audioCheckSkip(full)).toBeUndefined()
    expect(audioCheckPending(full)).toBe(false)
  })

  it("doesn't run without FXM Connect, in Lite or in the apps", () => {
    expect(audioCheckSkip(readyConnection())).toBe('no-connect')
    expect(
      audioCheckSkip(readyConnection({ connect: CONNECT_STATUS.outdated, lite: 'failed' })),
    ).toBe('no-connect')
    expect(
      audioCheckSkip(readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })),
    ).toBe('lite')
    expect(
      audioCheckSkip(
        readyConnection({
          platform: 'desktop',
          environment: 'tauri',
          capabilities: TIER_CAPABILITIES.full,
        }),
      ),
    ).toBe('app')
  })

  it('waits for detection', () => {
    expect(audioCheckSkip(DETECTING)).toBeUndefined()
    expect(audioCheckPending(DETECTING)).toBe(true)
  })
})

describe('describeAudioCheck', () => {
  const text = (result: AudioCheckResult, version: string | undefined = '0.2.0') =>
    describeAudioCheck(result, version)

  it('says the audio is readable', () => {
    expect(text({ kind: 'readable', host: HOST })).toEqual({
      title: 'Readable',
      explanation:
        'FXM Connect can read YouTube audio here, so YouTube downloads and the equalizer work.',
      tone: 'good',
    })
    expect(text({ kind: 'readable', host: HOST, redirectedTo: OTHER_HOST }).explanation).toBe(
      'FXM Connect can read YouTube audio here, also after YouTube sent the request on to another server, so YouTube downloads and the equalizer work.',
    )
  })

  it('asks FXM Connect older than 0.2.1 to update after a redirect or a refusal', () => {
    const redirected = text({ kind: 'redirected', host: HOST }, '0.2.0')
    expect(redirected).toEqual({
      title: 'Redirected to another server and not readable',
      explanation:
        "YouTube sent the request on to another server, and the browser wouldn't let FXM Connect read the audio from there, so YouTube downloads and the equalizer don't work.",
      advice: 'Update FXM Connect to the latest version.',
      tone: 'bad',
    })
    const refused = text({ kind: 'refused', host: HOST }, '0.1.0')
    expect(refused.title).toBe('Refused (CORS)')
    expect(refused.explanation).toBe(
      "YouTube's audio server answered, but the browser wouldn't let FXM Connect read the audio, so YouTube downloads and the equalizer don't work.",
    )
    expect(refused.advice).toBe(UPDATE_CONNECT_ADVICE)
    expect(text({ kind: 'refused', host: HOST }, undefined).advice).toBe(UPDATE_CONNECT_ADVICE)
  })

  it('names a hard block when FXM Connect is up to date, or nothing answers', () => {
    expect(text({ kind: 'redirected', host: HOST }, '0.2.1').advice).toBe(HARD_BLOCK_ADVICE)
    expect(text({ kind: 'refused', host: HOST }, '0.3.0').advice).toBe(
      'This browser or network stops FXM Connect from reading YouTube audio.',
    )
    expect(text({ kind: 'unreachable', host: HOST }, '0.2.0')).toEqual({
      title: 'Unreachable',
      explanation:
        "The browser couldn't get anything from YouTube's audio server on this page, so YouTube downloads and the equalizer don't work.",
      advice: HARD_BLOCK_ADVICE,
      tone: 'bad',
    })
  })

  it('names HTTP errors and time-outs', () => {
    expect(text({ kind: 'http-error', host: HOST, status: 403 })).toEqual({
      title: 'HTTP error 403',
      explanation: "YouTube's audio server refused the request.",
      advice:
        'Run the self-test again. If the error stays, YouTube may be refusing audio to this network.',
      tone: 'bad',
    })
    expect(text({ kind: 'http-error', host: HOST, status: 503 })).toMatchObject({
      title: 'HTTP error 503',
      explanation: "YouTube's audio server had a problem with the request.",
      advice: 'Try again in a few minutes.',
    })
    expect(text({ kind: 'timeout', host: HOST, timeoutMs: 10_000 })).toEqual({
      title: 'Timed out',
      explanation: "YouTube's audio server didn't answer within 10 s.",
      advice: 'Check the connection and run the self-test again.',
      tone: 'bad',
    })
  })

  it('says plainly why nothing was tested', () => {
    const skipped = (reason: Extract<AudioCheckResult, { kind: 'not-tested' }>['reason']) =>
      text({ kind: 'not-tested', reason })
    expect(skipped('no-connect')).toEqual({
      title: 'Not tested',
      explanation:
        "Without FXM Connect, this browser can't read YouTube audio, so YouTube downloads and the equalizer aren't available here.",
      tone: 'neutral',
    })
    expect(skipped('lite').explanation).toBe(
      "In Lite, YouTube songs play, but this browser can't read their audio, so YouTube downloads and the equalizer aren't available here.",
    )
    expect(skipped('app').explanation).toBe(
      "This check is for FXM Connect in a browser, which the app doesn't need.",
    )
    expect(skipped('no-stream').explanation).toBe('The song self-test found no stream to check.')
    expect(skipped('not-googlevideo').explanation).toBe(
      "The song self-test's stream doesn't come from YouTube's audio servers.",
    )
  })
})
