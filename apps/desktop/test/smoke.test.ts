import type { NetworkCapabilities, ProviderContext, StreamOption } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import {
  DEAD_PROXY,
  type MediaPlayer,
  Pending,
  PROBE_BYTES,
  runSmoke,
  type SmokeOptions,
  type SmokeReport,
  type SmokeYouTube,
  SPOTIFY_TIME_URL,
  SW_JS_DATA_URL,
  swJsDataVisitorData,
  verifiedStream,
} from '../smoke/steps'
import {
  FALLBACK_CLIENT_VERSION,
  interimYouTube,
  MUSIC_PAGE_URL,
  MUSIC_SEARCH_URL,
  pageClientVersion,
  plainMusicSearch,
  videoIds,
} from '../smoke/youtube'

const FULL: NetworkCapabilities = {
  youtube: 'full',
  mediaBytes: true,
  spotify: 'anonymous',
  fileSystem: true,
}
const FREE = { url: 'https://archive.org/download/x/x.mp3', label: 'Free track' }
const VIDEO_ID = 'dQw4w9WgXcQ'
const VISITOR_DATA = 'CgtWaXNpdG9yRGF0YSiAgICABg%3D%3D'
const CALLER_IP = '203.0.113.7'

/** A `sw.js_data` answer: the device info at [0][2][0][0], visitorData at 13, the IP at 3. */
function swJsData(visitorData: unknown = VISITOR_DATA): string {
  const deviceInfo: unknown[] = Array.from({ length: 17 }, () => null)
  deviceInfo[0] = 'en'
  deviceInfo[1] = 'US'
  deviceInfo[3] = CALLER_IP
  deviceInfo[13] = visitorData
  deviceInfo[16] = '1.20261020.10.00'
  return `)]}'\n${JSON.stringify([[null, null, [[deviceInfo]]]])}`
}

function stream(fullLength: StreamOption['fullLength']): StreamOption {
  return {
    url: `https://rr1---sn-x.googlevideo.com/videoplayback?itag=251&full=${fullLength}`,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength,
  }
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>

/** A provider context whose `fetch` answers like the services the smoke test calls. */
function context(route: Route = () => new Response('not found', { status: 404 })) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === SW_JS_DATA_URL) return new Response(swJsData())
    if (url === SPOTIFY_TIME_URL) return Response.json({ serverTime: 1793000000 })
    if (url === FREE.url) {
      const response = new Response(new Uint8Array(1000), {
        status: 206,
        headers: { 'content-range': 'bytes 427989-428988/428989' },
      })
      Object.defineProperty(response, 'url', { value: 'https://ia800.us.archive.org/x/x.mp3' })
      return response
    }
    return route(url, init)
  })
  const ctx = { fetch, platform: 'desktop', capabilities: FULL, mode: 'music' } as ProviderContext
  return { ctx, fetch }
}

const youtube = (overrides: Partial<SmokeYouTube> = {}): SmokeYouTube => ({
  search: async () => ({ videoId: VIDEO_ID, title: 'Creep' }),
  resolve: async () => [stream('capped'), stream('verified')],
  ...overrides,
})

const player = (overrides: Partial<MediaPlayer> = {}): MediaPlayer => ({
  playToEnd: async () => ({ durationS: 238.6 }),
  ...overrides,
})

/** Tauri's `invoke`, answering the HTTP plugin's commands as Rust does for a direct request. */
function pluginInvoke(send: () => Promise<unknown> = async () => ({ status: 302, rid: 2 })) {
  return vi.fn(async (command: string, _payload: unknown): Promise<unknown> => {
    if (command === 'plugin:http|fetch') return 1
    if (command === 'plugin:http|fetch_send') return send()
    return null
  })
}

const HOOK_STEP = 'page script can’t give the HTTP plugin a proxy'

/** The result of the step called `name`. */
const stepNamed = (report: SmokeReport, name: string) =>
  report.steps.find((step) => step.name === name)

function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  const { ctx } = context()
  return {
    context: () => ctx,
    capabilities: FULL,
    youtube: youtube(),
    player: player(),
    query: 'Radiohead Creep',
    freeTrack: FREE,
    invoke: pluginInvoke(),
    now: () => 0,
    ...overrides,
  }
}

describe('runSmoke', () => {
  it('passes when every step does: stage 7.2’s done-when', async () => {
    const played: string[] = []
    const report = await runSmoke(
      options({
        player: player({
          playToEnd: async (url) => {
            played.push(url)
            return { durationS: 238.6 }
          },
        }),
      }),
    )
    expect(report.ok).toBe(true)
    expect(report.steps.map((step) => [step.name, step.status])).toEqual([
      ['native networking', 'passed'],
      ['server-issued visitorData is readable', 'passed'],
      ['Spotify answers', 'passed'],
      ['YouTube Music search', 'passed'],
      ['VISIONOS URL passes the end-of-file probe', 'passed'],
      ['the track plays to the end', 'passed'],
      ['Free track: end-of-file probe', 'passed'],
      ['Free track: plays to the end', 'passed'],
      [HOOK_STEP, 'passed'],
    ])
    expect(played).toEqual([stream('verified').url, FREE.url])
    expect(stepNamed(report, 'Free track: end-of-file probe')?.detail).toContain(
      'ia800.us.archive.org',
    )
  })

  it('probes the free track’s last 64 KB with one range request', async () => {
    const { ctx, fetch } = context()
    await runSmoke(options({ context: () => ctx }))
    const probe = fetch.mock.calls.find(([url]) => url === FREE.url)
    expect(probe?.[1]).toEqual({ headers: { Range: `bytes=-${PROBE_BYTES}` } })
  })

  it('reports a stage that hasn’t merged as waiting, not failed', async () => {
    const report = await runSmoke(
      options({
        youtube: youtube({
          resolve: async () => {
            throw new Pending('needs stage 1.4')
          },
        }),
      }),
    )
    expect(report.ok).toBe(true)
    expect(report.steps.slice(4).map((step) => [step.status, step.detail])).toEqual([
      ['pending', 'needs stage 1.4'],
      ['pending', 'waits for a verified stream'],
      ['passed', expect.any(String)],
      ['passed', '238.6 s'],
      ['passed', expect.any(String)],
    ])
  })

  it('fails without native networking, a readable sw.js_data or a verified stream', async () => {
    const { ctx } = context()
    const forbidden = { ...ctx, fetch: async () => new Response('', { status: 403 }) }
    const report = await runSmoke(
      options({
        capabilities: {
          youtube: 'none',
          mediaBytes: false,
          spotify: 'unreachable',
          fileSystem: true,
        },
        context: () => forbidden as unknown as ProviderContext,
        youtube: youtube({ resolve: async () => [stream('capped'), stream('unverified')] }),
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.steps.map((step) => step.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'passed',
      'failed',
      'pending',
      'failed',
      'pending',
      'passed',
    ])
    expect(stepNamed(report, 'VISIONOS URL passes the end-of-file probe')?.detail).toBe(
      'no stream passed the probe: opus capped, opus unverified',
    )
    expect(stepNamed(report, 'Spotify answers')?.detail).toContain('answered 403')
  })

  it('fails when a track doesn’t play to its end', async () => {
    const report = await runSmoke(
      options({
        player: player({
          playToEnd: async () => {
            throw new Error('media error 4')
          },
        }),
      }),
    )
    expect(report.ok).toBe(false)
    expect(
      report.steps.filter((step) => step.status === 'failed').map((step) => step.name),
    ).toEqual(['the track plays to the end', 'Free track: plays to the end'])
  })

  it('fails a free source that ignores the range', async () => {
    const whole = { ...context().ctx }
    whole.fetch = (async (input: RequestInfo | URL) =>
      String(input) === SW_JS_DATA_URL
        ? new Response(`)]}'`)
        : new Response(new Uint8Array(PROBE_BYTES * 2))) as typeof fetch
    const report = await runSmoke(options({ context: () => whole }))
    const probe = stepNamed(report, 'Free track: end-of-file probe')
    expect(probe?.status).toBe('failed')
    expect(probe?.detail).toContain('answered 200')
  })

  it('reads the server-issued visitorData without reporting it or the caller’s IP', async () => {
    const report = await runSmoke(options())
    const step = stepNamed(report, 'server-issued visitorData is readable')
    expect(step?.status).toBe('passed')
    expect(step?.detail).toBe(
      `sw.js_data issued a visitorData of ${VISITOR_DATA.length} characters`,
    )
    expect(JSON.stringify(report)).not.toContain(VISITOR_DATA)
    expect(JSON.stringify(report)).not.toContain(CALLER_IP)
  })

  it.each([
    ['no visitorData', swJsData(null)],
    ['an empty visitorData', swJsData('')],
    ['another shape', `)]}'\n[["visitor"]]`],
    ['no JSON after the guard', `)]}'\n<html>`],
  ])('fails when sw.js_data answers with %s, and never reports the answer', async (_, body) => {
    const { ctx } = context()
    const answering = {
      ...ctx,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === SW_JS_DATA_URL ? new Response(body) : ctx.fetch(input, init),
    }
    const report = await runSmoke(options({ context: () => answering as ProviderContext }))
    const step = stepNamed(report, 'server-issued visitorData is readable')
    expect(step?.status).toBe('failed')
    expect(step?.detail).toMatch(/^sw\.js_data answered \d+ characters without a visitorData$/)
    expect(JSON.stringify(report)).not.toContain(CALLER_IP)
  })

  it('calls the HTTP plugin directly, as page script can, with a dead proxy in Maps', async () => {
    const invoke = pluginInvoke()
    const report = await runSmoke(options({ invoke }))
    expect(stepNamed(report, HOOK_STEP)).toMatchObject({
      status: 'passed',
      detail: `archive.org answered 302 directly, not through ${DEAD_PROXY}`,
    })
    const [first, ...rest] = invoke.mock.calls
    expect(first?.[0]).toBe('plugin:http|fetch')
    // Maps, which Tauri's serializer turns into objects only after the isolation hook.
    const payload = first?.[1]
    expect(payload).toBeInstanceOf(Map)
    const request = (payload as Map<string, unknown>).get('clientConfig')
    expect(request).toBeInstanceOf(Map)
    expect(Object.fromEntries(request as Map<string, unknown>)).toEqual({
      method: 'HEAD',
      url: FREE.url,
      headers: [['user-agent', expect.stringMatching(/^FXM /)]],
      data: null,
      maxRedirections: 0,
      proxy: { all: DEAD_PROXY },
    })
    expect(rest).toEqual([
      ['plugin:http|fetch_send', { rid: 1 }],
      ['plugin:http|fetch_cancel_body', { rid: 2 }],
    ])
  })

  it('fails when the plugin can’t send that request, as through the proxy it couldn’t', async () => {
    const invoke = pluginInvoke(async () => {
      throw 'error sending request for url (https://archive.org/download/x/x.mp3)'
    })
    const report = await runSmoke(options({ invoke }))
    expect(report.ok).toBe(false)
    expect(stepNamed(report, HOOK_STEP)).toMatchObject({
      status: 'failed',
      detail: `the request failed, as it would through ${DEAD_PROXY}: error sending request for url (https://archive.org/download/x/x.mp3)`,
    })
  })

  it('finds the visitorData only where sw.js_data puts it', () => {
    expect(swJsDataVisitorData(swJsData())).toBe(VISITOR_DATA)
    expect(swJsDataVisitorData(swJsData(42))).toBeUndefined()
    expect(swJsDataVisitorData(JSON.stringify([[null, null, [[[]]]]]))).toBeUndefined()
  })

  it('picks the verified stream', () => {
    expect(verifiedStream([stream('capped'), stream('verified')])).toEqual(stream('verified'))
    expect(verifiedStream([stream('unverified')])).toBeUndefined()
  })
})

describe('the interim YouTube Music search', () => {
  const PAGE = `<script>ytcfg.set({"INNERTUBE_CLIENT_NAME":"WEB_REMIX","INNERTUBE_CLIENT_VERSION":"1.20261021.03.00"});</script>`
  const RESULTS = {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          { musicShelf: [{ videoId: VIDEO_ID }, { playlistItemData: { videoId: 'XFkzRNyygfk' } }] },
          { videoId: VIDEO_ID },
        ],
      },
    },
  }

  it('reads the client version from YouTube Music’s page', () => {
    expect(pageClientVersion(PAGE)).toBe('1.20261021.03.00')
    expect(pageClientVersion('<html></html>')).toBeUndefined()
  })

  it('finds every videoId once, in order', () => {
    expect(videoIds(RESULTS)).toEqual([VIDEO_ID, 'XFkzRNyygfk'])
    expect(videoIds({ videoId: 'short' })).toEqual([])
  })

  it('sends one WEB_REMIX search in the simple shape', async () => {
    const { ctx, fetch } = context((url) =>
      url === MUSIC_PAGE_URL ? new Response(PAGE) : Response.json(RESULTS),
    )
    expect(await plainMusicSearch('Radiohead Creep', ctx)).toEqual({
      videoId: VIDEO_ID,
      title: '2 results, client 1.20261021.03.00',
    })
    const search = fetch.mock.calls.find(([url]) => url === MUSIC_SEARCH_URL)
    expect(search?.[1]?.method).toBe('POST')
    expect(search?.[1]?.headers).toBeUndefined()
    expect(JSON.parse(String(search?.[1]?.body))).toEqual({
      context: {
        client: { clientName: 'WEB_REMIX', clientVersion: '1.20261021.03.00', hl: 'en', gl: 'US' },
      },
      query: 'Radiohead Creep',
    })
  })

  it('falls back to a known client version, and fails on an error or no results', async () => {
    const empty = context((url) =>
      url === MUSIC_PAGE_URL ? new Response('', { status: 500 }) : Response.json({}),
    )
    await expect(plainMusicSearch('x', empty.ctx)).rejects.toThrow('found nothing')
    const body = empty.fetch.mock.calls.find(([url]) => url === MUSIC_SEARCH_URL)?.[1]?.body
    expect(JSON.parse(String(body)).context.client.clientVersion).toBe(FALLBACK_CLIENT_VERSION)
    const refused = context((url) =>
      url === MUSIC_PAGE_URL ? new Response(PAGE) : new Response('', { status: 403 }),
    )
    await expect(plainMusicSearch('x', refused.ctx)).rejects.toThrow('403')
  })

  it('leaves the resolve to stage 1.4', async () => {
    await expect(interimYouTube.resolve(VIDEO_ID, context().ctx)).rejects.toBeInstanceOf(Pending)
  })
})
