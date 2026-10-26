/**
 * A fake network for the composition root's tests: the services run for real, and only the
 * network answers from recorded fixtures. It answers what the real providers send, as the hosts
 * look through FXM Connect (with CORS headers):
 *
 * - YouTube: `sw.js_data` with a visitorData, InnerTube's search (a recorded songs search for
 *   any query), the empty suggestions call that asks for a visitorData, and `/player`, a
 *   recorded VISIONOS answer rewritten for the video asked for (its ID, and URLs that expire six
 *   hours from now);
 * - googlevideo: ranged GETs as a file of the URL's `clen` (zeros), so end-of-file probes pass,
 *   and a request from the start of the file (what a media element sends) with `audio`;
 * - Internet Archive: a recorded search, recorded items by identifier (others are unknown), and
 *   `audio` for every file download;
 * - MusicBrainz: nothing found, as for a Spotify track no recording links;
 * - when the fixtures have them: other InnerTube searches by their filter's `params`, a radio
 *   (`next` with `RDAMVM…`), `browse` pages by `browseId`, and ListenBrainz's labs answers by
 *   endpoint (`acr-lookup/json`, `similar-artists/json`).
 *
 * Anything else is refused with a network error, like a host that does not answer. Both the
 * Vitest tests and the Playwright test (`e2e/playback.spec.ts`) use it, so it imports nothing:
 * the fixtures are passed in.
 *
 * @module
 */

/** The recorded answers the fake network serves. */
export interface FakeNetworkFixtures {
  /** A YouTube Music songs search (InnerTube `search` with the songs filter). */
  readonly songs: unknown
  /** A VISIONOS `/player` answer for a song; rewritten for the video each request asks for. */
  readonly player: unknown
  /** An Internet Archive search (`advancedsearch.php`). */
  readonly archiveSearch: unknown
  /** Internet Archive items (`/metadata/<identifier>`), by identifier. */
  readonly archiveItems: Readonly<Record<string, unknown>>
  /** Other searches, by the filter's `params`, e.g. the artists filter's; the rest get `songs`. */
  readonly searches?: Readonly<Record<string, unknown>>
  /** A radio, the answer to every `next` call for a `RDAMVM…` playlist. */
  readonly radio?: unknown
  /** `browse` answers by `browseId`: artist pages, playlists. */
  readonly browse?: Readonly<Record<string, unknown>>
  /** ListenBrainz's labs API, by endpoint: `acr-lookup/json`, `similar-artists/json`. */
  readonly listenbrainz?: Readonly<Record<string, unknown>>
}

/** Options for {@link createFakeNetwork}. */
export interface FakeNetworkOptions {
  /** The recorded answers. */
  readonly fixtures: FakeNetworkFixtures
  /**
   * The file served to media requests (googlevideo from the start of the file, Internet Archive
   * downloads): something a browser plays, e.g. {@link wavTone}. Default: a few zero bytes.
   */
  readonly audio?: Uint8Array
  /** The clock, for the URLs' expiry. Default: `Date.now`. */
  readonly now?: () => number
  /** The visitorData `sw.js_data` and the suggestions call issue. */
  readonly visitorData?: string
}

/** One request the fake network received. */
export interface FakeRequest {
  /** `GET`, `POST`, … */
  readonly method: string
  /** The full URL. */
  readonly url: string
  /** The headers, lower-cased. */
  readonly headers: Readonly<Record<string, string>>
  /** The body, for a `POST`. */
  readonly body?: string
}

/** The fake network. */
export interface FakeNetwork {
  /** A `fetch` over it. Rejects with the signal's reason when the request is cancelled. */
  readonly fetch: typeof globalThis.fetch
  /** Answers one request, e.g. one a browser test intercepted. */
  respond(request: FakeRequest): Response
  /** Every request so far, in order. */
  readonly requests: readonly FakeRequest[]
  /** The videoIds `/player` was asked for, in order. */
  readonly players: readonly string[]
}

/** A visitorData as YouTube issues them (the YouTube fixtures' sanitized one). */
export const FAKE_VISITOR_DATA = 'CgtGWE1fZml4dHVyZSiAgICAgICAgIAB'

/** The headers FXM Connect adds for the FXM origin, and that CORS-friendly hosts send. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges',
}

/**
 * A mono 16-bit PCM WAV file of a quiet tone, `seconds` long: a file every browser decodes,
 * whatever the URL it is served at says, so tests can play real audio offline.
 */
export function wavTone(seconds: number, sampleRate = 8000): Uint8Array {
  const samples = Math.round(seconds * sampleRate)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // the format chunk's size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per frame
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2000),
      true,
    )
  }
  return bytes
}

/** A `sw.js_data` body as YouTube sends it: the `)]}'` guard, then JSPB with the visitorData. */
function swJsData(visitorData: string): string {
  const device: unknown[] = Array.from({ length: 20 }, () => null)
  device[0] = 'en'
  device[1] = 'IN'
  device[3] = '192.0.2.1'
  device[13] = visitorData
  device[16] = '2.20261023.01.00'
  return `)]}'\n${JSON.stringify([['yt.sw.adr', null, [[device], 'public-api-key']]])}`
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=UTF-8' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The recorded `/player` answer, rewritten for `videoId`, its URLs valid for six hours. */
function playerFor(template: unknown, videoId: string, now: number): unknown {
  const answer = structuredClone(template)
  if (!isRecord(answer)) return answer
  if (isRecord(answer.videoDetails)) answer.videoDetails.videoId = videoId
  const streaming = answer.streamingData
  if (!isRecord(streaming)) return answer
  const expire = String(Math.floor(now / 1000) + 21_600)
  streaming.expiresInSeconds = '21540'
  for (const list of [streaming.adaptiveFormats, streaming.formats]) {
    if (!Array.isArray(list)) continue
    for (const format of list) {
      if (!isRecord(format) || typeof format.url !== 'string') continue
      const url = new URL(format.url)
      url.searchParams.set('id', videoId)
      url.searchParams.set('expire', expire)
      format.url = url.href
    }
  }
  return answer
}

/** The bytes a ranged GET asks for, as `[first, last]`, or `undefined` without a range. */
function rangeOf(
  headers: Readonly<Record<string, string>>,
): [number, number | undefined] | undefined {
  const match = /^bytes=(\d+)-(\d*)$/u.exec(headers.range ?? '')
  if (match === null) return undefined
  return [Number(match[1]), match[2] === '' ? undefined : Number(match[2])]
}

/** A media file: the whole of it, or the range asked for. */
function media(bytes: Uint8Array, range: [number, number | undefined] | undefined): Response {
  const type = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }
  if (range === undefined) {
    return new Response(bytes.slice(), {
      headers: { ...CORS, ...type, 'content-length': String(bytes.length) },
    })
  }
  const first = Math.min(range[0], bytes.length - 1)
  const last = Math.min(range[1] ?? bytes.length - 1, bytes.length - 1)
  return new Response(bytes.slice(first, last + 1), {
    status: 206,
    headers: {
      ...CORS,
      ...type,
      'content-length': String(last - first + 1),
      'content-range': `bytes ${first}-${last}/${bytes.length}`,
    },
  })
}

/** Creates a fake network: see the module documentation. */
export function createFakeNetwork(options: FakeNetworkOptions): FakeNetwork {
  const { fixtures } = options
  const now = options.now ?? Date.now
  const audio = options.audio ?? new Uint8Array(64)
  const visitorData = options.visitorData ?? FAKE_VISITOR_DATA
  const requests: FakeRequest[] = []
  const players: string[] = []

  function innerTube(endpoint: string, body: Record<string, unknown>): Response {
    switch (endpoint) {
      case 'search': {
        const params = typeof body.params === 'string' ? body.params : ''
        return json(fixtures.searches?.[params] ?? fixtures.songs)
      }
      case 'next': {
        const playlistId = typeof body.playlistId === 'string' ? body.playlistId : ''
        if (fixtures.radio === undefined || !playlistId.startsWith('RDAMVM')) break
        return json(fixtures.radio)
      }
      case 'browse': {
        const page = fixtures.browse?.[String(body.browseId)]
        if (page === undefined) break
        return json(page)
      }
      case 'music/get_search_suggestions':
        return json({ responseContext: { visitorData }, contents: [] })
      case 'player': {
        const videoId = String(body.videoId)
        players.push(videoId)
        return json(playerFor(fixtures.player, videoId, now()))
      }
      default:
        break
    }
    return json({ error: { code: 404, status: 'NOT_FOUND' } }, 404)
  }

  function googleVideo(url: URL, headers: Readonly<Record<string, string>>): Response {
    const range = rangeOf(headers)
    // A media element asks from the start of the file: give it something it can play.
    if (range === undefined || (range[0] === 0 && range[1] === undefined))
      return media(audio, range)
    const length = Number(url.searchParams.get('clen') ?? Number.NaN)
    if (!Number.isFinite(length)) return new Response(null, { status: 403, headers: CORS })
    const first = range[0]
    const last = Math.min(range[1] ?? length - 1, length - 1)
    return new Response(new Uint8Array(last - first + 1), {
      status: 206,
      headers: {
        ...CORS,
        'content-type': url.searchParams.get('mime') ?? 'audio/webm',
        'content-length': String(last - first + 1),
        'content-range': `bytes ${first}-${last}/${length}`,
      },
    })
  }

  function archive(url: URL, headers: Readonly<Record<string, string>>): Response {
    if (url.pathname === '/advancedsearch.php') return json(fixtures.archiveSearch)
    const item = /^\/metadata\/([^/]+)$/u.exec(url.pathname)
    if (item !== null) return json(fixtures.archiveItems[decodeURIComponent(item[1] ?? '')] ?? {})
    if (url.pathname.startsWith('/download/')) return media(audio, rangeOf(headers))
    return json({}, 404)
  }

  function respond(received: FakeRequest): Response {
    // Header names are case-insensitive, and not every Headers implementation lower-cases them.
    const request: FakeRequest = {
      ...received,
      headers: Object.fromEntries(
        Object.entries(received.headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    }
    requests.push(request)
    const url = new URL(request.url)
    if (url.hostname === 'www.youtube.com' && url.pathname === '/sw.js_data') {
      return new Response(swJsData(visitorData), {
        headers: { ...CORS, 'content-type': 'application/json' },
      })
    }
    if (
      ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com'].includes(url.hostname) &&
      url.pathname.startsWith('/youtubei/v1/')
    ) {
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(request.body ?? '{}')
        if (isRecord(parsed)) body = parsed
      } catch {
        // Not JSON: InnerTube would refuse it, and so does the default branch.
      }
      return innerTube(url.pathname.slice('/youtubei/v1/'.length), body)
    }
    if (url.hostname.endsWith('.googlevideo.com')) return googleVideo(url, request.headers)
    if (url.hostname === 'archive.org') return archive(url, request.headers)
    if (url.hostname === 'musicbrainz.org') return json({ error: 'Not Found' }, 404)
    if (url.hostname === 'labs.api.listenbrainz.org' && fixtures.listenbrainz !== undefined) {
      const answer = fixtures.listenbrainz[url.pathname.slice(1)]
      return answer === undefined ? json([], 404) : json(answer)
    }
    throw new TypeError(`Failed to fetch: the fake network has no ${url.host}`)
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const url = input instanceof Request ? input.url : String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (value, name) => {
        headers[name] = value
      },
    )
    const body = typeof init?.body === 'string' ? init.body : undefined
    return respond({
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      url,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  }

  return { fetch, respond, requests, players }
}
