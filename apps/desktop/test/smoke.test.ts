import type { NetworkCapabilities, ProviderContext, StreamOption } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import {
  type MediaPlayer,
  Pending,
  PROBE_BYTES,
  runSmoke,
  type SmokeOptions,
  type SmokeYouTube,
  SW_JS_DATA_URL,
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
    if (url === SW_JS_DATA_URL) return new Response(`)]}'\n[["visitor"]]`)
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

function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  const { ctx } = context()
  return {
    context: () => ctx,
    capabilities: FULL,
    youtube: youtube(),
    player: player(),
    query: 'Radiohead Creep',
    freeTrack: FREE,
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
      ['YouTube Music search', 'passed'],
      ['VISIONOS URL passes the end-of-file probe', 'passed'],
      ['the track plays to the end', 'passed'],
      ['Free track: end-of-file probe', 'passed'],
      ['Free track: plays to the end', 'passed'],
    ])
    expect(played).toEqual([stream('verified').url, FREE.url])
    expect(report.steps[5]?.detail).toContain('ia800.us.archive.org')
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
    expect(report.steps.slice(3).map((step) => [step.status, step.detail])).toEqual([
      ['pending', 'needs stage 1.4'],
      ['pending', 'waits for a verified stream'],
      ['passed', expect.any(String)],
      ['passed', '238.6 s'],
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
      'passed',
      'failed',
      'pending',
      'failed',
      'pending',
    ])
    expect(report.steps[3]?.detail).toBe('no stream passed the probe: opus capped, opus unverified')
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
    expect(report.steps[5]).toMatchObject({ status: 'failed' })
    expect(report.steps[5]?.detail).toContain('answered 200')
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
