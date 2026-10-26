import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  formatId,
  type NetworkCapabilities,
  type ProviderContext,
  type SearchResults,
  type StreamOption,
  type Track,
} from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import {
  describeRun,
  type ReadableRun,
  readableCandidates,
  readablePath,
  runPassed,
  streamLabel,
} from '../smoke/readable'
import {
  DEAD_PROXY,
  type MediaPlayer,
  Pending,
  PROBE_BYTES,
  type ReadablePath,
  runSmoke,
  type SmokeOptions,
  type SmokeReport,
  type SmokeYouTube,
  SPOTIFY_TIME_URL,
  SW_JS_DATA_URL,
  swJsDataVisitorData,
  verifiedStream,
} from '../smoke/steps'
import { smokeYouTube, songCandidate, type YouTubeParts } from '../smoke/youtube'

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

describe('the YouTube Music search and stream ladder (stages 1.3 and 1.4)', () => {
  const track: Track = {
    id: formatId('ytm', 'track', VIDEO_ID),
    source: 'ytm',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    artwork: [],
    kind: 'song',
  }

  function parts(results: SearchResults = { tracks: { items: [track] } }) {
    const search = vi.fn(async () => results)
    const resolve = vi.fn(async (_candidate: AudioCandidate) => [stream('verified')])
    const load = vi.fn(
      async (): Promise<YouTubeParts> =>
        ({ music: { search }, audio: { resolve } }) as unknown as YouTubeParts,
    )
    return { load, search, resolve }
  }

  it('finds the first song of a YouTube Music search', async () => {
    const { load, search } = parts()
    const youtube = smokeYouTube(load)
    const { ctx } = context()
    expect(await youtube.search('Radiohead Creep', ctx)).toEqual({
      videoId: VIDEO_ID,
      title: 'Creep – Radiohead',
    })
    expect(search).toHaveBeenCalledWith('Radiohead Creep', { types: ['track'] }, ctx)
  })

  it('fails when the search finds no song', async () => {
    const youtube = smokeYouTube(parts({ tracks: { items: [] } }).load)
    await expect(youtube.search('x', context().ctx)).rejects.toThrow('found no songs')
  })

  it('resolves the song’s own audio with the default quality, loading the stages once', async () => {
    const { load, resolve } = parts()
    const youtube = smokeYouTube(load)
    const { ctx } = context()
    await youtube.search('Radiohead Creep', ctx)
    expect(await youtube.resolve(VIDEO_ID, ctx)).toEqual([stream('verified')])
    expect(resolve).toHaveBeenCalledWith(songCandidate(VIDEO_ID), ctx, DEFAULT_QUALITY_PREFS)
    expect(songCandidate(VIDEO_ID)).toMatchObject({ source: 'ytm', ref: VIDEO_ID, kind: 'song' })
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('the readable audio path (stage 7.6)', () => {
  const aac: StreamOption = {
    ...stream('verified'),
    url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140',
    codec: 'aac',
    container: 'm4a',
  }
  const muxed: StreamOption = {
    ...aac,
    url: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=18',
    container: 'mp4',
    media: 'muxed-video',
  }

  const run = (overrides: Partial<ReadableRun> = {}): ReadableRun => ({
    label: 'Opus in WebM',
    startedMs: 812.4,
    playedS: 6.2,
    durationS: 238.6,
    ended: true,
    peak: 0.62,
    contextState: 'running',
    direct: 'refused',
    plainStartedMs: 640.2,
    plainDurationS: 238.6,
    ...overrides,
  })

  it('checks one verified googlevideo audio stream of each container', () => {
    const archive = { ...stream('verified'), url: 'https://archive.org/download/x/x.mp3' }
    expect(
      readableCandidates([
        muxed,
        stream('capped'),
        stream('verified'),
        { ...stream('verified'), url: `${stream('verified').url}&second` },
        aac,
        archive,
        { ...aac, protocol: 'sabr' },
      ]),
    ).toEqual([stream('verified'), aac, muxed])
    expect(readableCandidates([stream('unverified')])).toEqual([])
  })

  it('names streams by codec and container', () => {
    expect(streamLabel(stream('verified'))).toBe('Opus in WebM')
    expect(streamLabel(aac)).toBe('AAC in M4A')
    expect(streamLabel(muxed)).toBe('AAC in MP4 video')
  })

  it('passes a stream that played from the start and to its end', () => {
    expect(runPassed(run(), 6)).toBe(true)
    expect(runPassed(run({ playedS: 2 }), 6)).toBe(false)
    expect(runPassed(run({ ended: false }), 6)).toBe(false)
    expect(describeRun(run())).toBe(
      'Opus in WebM: started 812 ms after loading, played 6.2 s, then its end after a seek ' +
        '(238.6 s in all); Web Audio read samples up to 0.62 (context running); its own URL in ' +
        'such an element: refused, as googlevideo sends no CORS headers; in a plain element it ' +
        'started 640 ms after loading (238.6 s in all)',
    )
    const { plainStartedMs: _, ...neverStarted } = run()
    expect(describeRun(neverStarted)).toContain('in a plain element it didn’t start')
    expect(describeRun(run({ peak: 0, direct: 'played' }))).toContain('Web Audio read only silence')
  })

  it('checks each stream in turn, and fails when one didn’t play from the scheme', async () => {
    const probe = vi.fn(async (option: StreamOption) => run({ label: streamLabel(option) }))
    const detail = await readablePath(probe).check([stream('verified'), aac])
    expect(probe.mock.calls.map(([option]) => option.url)).toEqual([
      stream('verified').url,
      aac.url,
    ])
    expect(detail).toContain('Opus in WebM: started')
    expect(detail).toContain('. AAC in M4A: started')
    const failing = readablePath(async () => run({ ended: false }))
    await expect(failing.check([aac])).rejects.toThrow('but not its end')
    await expect(readablePath(probe).check([stream('unverified')])).rejects.toThrow(
      'no verified googlevideo stream',
    )
  })

  it('runs right after the probe, on everything the resolve found', async () => {
    const check = vi.fn(async (_options: readonly StreamOption[]) => 'played through fxm-media')
    const readable: ReadablePath = { check }
    const report = await runSmoke(options({ readable }))
    expect(report.ok).toBe(true)
    expect(report.steps.slice(4, 7).map((step) => [step.name, step.status])).toEqual([
      ['VISIONOS URL passes the end-of-file probe', 'passed'],
      ['Web Audio reads it through fxm-media', 'passed'],
      ['the track plays to the end', 'passed'],
    ])
    expect(check).toHaveBeenCalledWith([stream('capped'), stream('verified')])
  })

  it('fails the run when the readable path fails, and waits without a verified stream', async () => {
    const readable: ReadablePath = {
      check: async () => {
        throw new Error('media error 4')
      },
    }
    const failed = await runSmoke(options({ readable }))
    expect(failed.ok).toBe(false)
    expect(stepNamed(failed, 'Web Audio reads it through fxm-media')).toMatchObject({
      status: 'failed',
      detail: 'media error 4',
    })
    const waiting = await runSmoke(
      options({ readable, youtube: youtube({ resolve: async () => [stream('capped')] }) }),
    )
    expect(stepNamed(waiting, 'Web Audio reads it through fxm-media')).toMatchObject({
      status: 'pending',
      detail: 'waits for a verified stream',
    })
  })
})
