/**
 * One local HTTPS server that stands in for every host the e2e test touches. Chromium's
 * --host-resolver-rules sends the real host names here, so the extension's DNR rules (which
 * match real host names) apply exactly as they would online.
 *
 * Each mock reproduces the behaviour measured against the live services:
 * - InnerTube: 403 without CORS headers for a foreign Origin, 200 for a YouTube Origin or none.
 *   Preflights get 403 for a foreign Origin or none, 400 for the host's own origin or without
 *   Access-Control-Request-Method, and 200 with CORS headers for the other YouTube origin.
 * - googlevideo: media bytes for any Origin (Cross-Origin-Resource-Policy: cross-origin) but
 *   Access-Control-Allow-Origin only for YouTube origins; preflights get 204 for a YouTube
 *   Origin and 400 otherwise. `redirect=cross` (or `same`) in the query answers with a 302 to
 *   another googlevideo host (or the same one) with `cms_redirect=yes`, as googlevideo does.
 * - open.spotify.com /api/token and /api/server-time, and Last.fm stations: no CORS headers,
 *   OPTIONS answered with 200.
 * - clienttoken.spotify.com: CORS headers only for the Origin https://open.spotify.com, OPTIONS
 *   answered with 200 either way. FXM Connect has no rule for it, so pages can't read it.
 * - api-partner.spotify.com (pathfinder GraphQL) and spclient.wg.spotify.com: echo any Origin
 *   with credentials allowed, and answer preflights with their own allow lists.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'

export const FXM_HOST = 'fxmusic.pages.dev'
/** A preview deployment on a sub-domain of the FXM host, which is not an FXM origin. */
export const FXM_PREVIEW_HOST = 'a1b2c3d4.fxmusic.pages.dev'
export const OTHER_HOST = 'not-fxm.example'
export const YOUTUBE_HOSTS = ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com']
export const GOOGLEVIDEO_HOST = 'rr1---sn-mock.googlevideo.com'
/** The googlevideo host `redirect=cross` sends media requests to. */
export const GOOGLEVIDEO_OTHER_HOST = 'rr5---sn-other.googlevideo.com'
export const SPOTIFY_HOST = 'open.spotify.com'
export const CLIENTTOKEN_HOST = 'clienttoken.spotify.com'
export const PARTNER_HOST = 'api-partner.spotify.com'
export const SPCLIENT_HOST = 'spclient.wg.spotify.com'
export const LASTFM_HOST = 'www.last.fm'
export const MOCK_HOSTS = [
  FXM_HOST,
  FXM_PREVIEW_HOST,
  OTHER_HOST,
  ...YOUTUBE_HOSTS,
  GOOGLEVIDEO_HOST,
  GOOGLEVIDEO_OTHER_HOST,
  SPOTIFY_HOST,
  CLIENTTOKEN_HOST,
  PARTNER_HOST,
  SPCLIENT_HOST,
  LASTFM_HOST,
]

const YOUTUBE_ORIGINS = new Set(['https://www.youtube.com', 'https://music.youtube.com'])

/** A 4096-byte WAV file (8-bit mono PCM at 8 kHz, about half a second of silence). */
export const MEDIA = (() => {
  const samples = 4096 - 44
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(8000, 24) // sample rate
  header.writeUInt32LE(8000, 28) // byte rate
  header.writeUInt16LE(1, 32) // block align
  header.writeUInt16LE(8, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples, 40)
  return Buffer.concat([header, Buffer.alloc(samples, 128)])
})()

export interface LoggedRequest {
  host: string
  method: string
  path: string
  status: number
  origin?: string
  referer?: string
  cookie?: string
  contentType?: string
  requestHeaders?: string
}

export interface MockServer {
  port: number
  log: LoggedRequest[]
  /** Requests to a host (and optionally a path prefix) since the last `clearLog()`. */
  requests(host: string, pathPrefix?: string): LoggedRequest[]
  clearLog(): void
  close(): Promise<void>
}

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>FXM Connect e2e</title></head>
  <body><h1>FXM Connect e2e page</h1></body>
</html>
`

type Reply = { status: number; headers?: Record<string, string>; body?: string | Buffer }

function json(value: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  }
}

function innertubePreflight(req: IncomingMessage, host: string): Reply {
  const origin = req.headers.origin
  if (origin === undefined || !YOUTUBE_ORIGINS.has(origin)) {
    return { status: 403, headers: { 'content-type': 'text/html' }, body: 'Forbidden' }
  }
  if (origin === `https://${host}` || !req.headers['access-control-request-method']) {
    return { status: 400, headers: { 'content-type': 'text/html' }, body: 'Bad Request' }
  }
  return {
    status: 200,
    headers: {
      'content-type': 'text/html',
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
      'access-control-max-age': '3600',
    },
  }
}

function innertube(req: IncomingMessage, host: string, body: string): Reply {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') return innertubePreflight(req, host)
  if (origin !== undefined && !YOUTUBE_ORIGINS.has(origin)) {
    return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'forbidden origin' }
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  const cors: Record<string, string> = origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }
    : {}
  return json(
    {
      host,
      seenOrigin: origin ?? null,
      seenReferer: req.headers.referer ?? null,
      sawCookie: req.headers.cookie !== undefined,
      body: parsed,
    },
    { ...cors, 'set-cookie': 'VISITOR_INFO1_LIVE=mock; Path=/; Secure; SameSite=None' },
  )
}

function googlevideo(req: IncomingMessage, host: string, url: URL): Reply {
  const origin = req.headers.origin
  const youtube = origin !== undefined && YOUTUBE_ORIGINS.has(origin)
  const redirect = url.searchParams.get('redirect')
  if (req.method !== 'OPTIONS' && redirect !== null) {
    const location = new URL(url)
    location.host = redirect === 'cross' ? GOOGLEVIDEO_OTHER_HOST : host
    location.searchParams.delete('redirect')
    location.searchParams.set('cms_redirect', 'yes')
    return {
      status: 302,
      headers: {
        location: location.href,
        'content-type': 'text/html',
        'cross-origin-resource-policy': 'cross-origin',
        ...(youtube ? { 'access-control-allow-origin': origin } : {}),
      },
    }
  }
  if (req.method === 'OPTIONS') {
    if (!youtube) return { status: 400, headers: { 'content-type': 'text/plain' } }
    return {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET,HEAD,POST',
        'access-control-allow-headers': 'Accept-Language,Content-Type,Origin,Range',
        'access-control-max-age': '86400',
        'cross-origin-resource-policy': 'cross-origin',
      },
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'Origin',
  }
  if (youtube) headers['access-control-allow-origin'] = origin
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : MEDIA.length - 1, MEDIA.length - 1)
    headers['content-range'] = `bytes ${start}-${end}/${MEDIA.length}`
    return { status: 206, headers, body: MEDIA.subarray(start, end + 1) }
  }
  return { status: 200, headers, body: MEDIA }
}

function spotify(req: IncomingMessage, url: URL): Reply {
  if (req.method === 'OPTIONS') return { status: 200, headers: { 'content-type': 'text/plain' } }
  if (url.pathname === '/api/server-time') return json({ serverTime: 1_800_000_000 })
  if (url.pathname === '/api/token') {
    const session = /(?:^|;\s*)sp_dc=/.test(req.headers.cookie ?? '')
    return json(
      session
        ? { accessToken: 'user-token', isAnonymous: false, clientId: 'mock' }
        : { accessToken: 'anonymous-token', isAnonymous: true, clientId: 'mock' },
      { 'set-cookie': 'sp_t=mock; Path=/; Secure; SameSite=None' },
    )
  }
  return { status: 404 }
}

/** The headers a request carried, for the mock replies the test reads back. */
function seen(req: IncomingMessage) {
  return { seenOrigin: req.headers.origin ?? null, seenReferer: req.headers.referer ?? null }
}

function clienttoken(req: IncomingMessage): Reply {
  const spotify = req.headers.origin === 'https://open.spotify.com'
  const cors: Record<string, string> = spotify
    ? { 'access-control-allow-origin': 'https://open.spotify.com' }
    : {}
  if (req.method === 'OPTIONS') {
    return {
      status: 200,
      headers: spotify
        ? {
            ...cors,
            'access-control-allow-methods': 'GET,POST',
            'access-control-allow-headers': 'accept,content-type,origin,authorization',
          }
        : {},
    }
  }
  return json(
    {
      response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE',
      granted_token: { token: 'mock-client-token' },
      ...seen(req),
    },
    cors,
  )
}

/** api-partner and spclient: any Origin is echoed, with credentials. */
function echoingSpotify(req: IncomingMessage, host: string, url: URL): Reply {
  const origin = req.headers.origin
  const cors: Record<string, string> = origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }
    : {}
  if (req.method === 'OPTIONS') {
    return {
      status: 200,
      headers: {
        ...cors,
        'access-control-allow-methods': 'DELETE,GET,PATCH,POST,PUT,OPTIONS',
        'access-control-allow-headers':
          'Accept,Authorization,Origin,Content-Type,Spotify-App-Version,App-Platform,client-token',
        'access-control-max-age': '604800',
      },
    }
  }
  return json({ host, path: url.pathname, ...seen(req) }, cors)
}

function route(req: IncomingMessage, host: string, url: URL, body: string): Reply {
  if (host === FXM_HOST || host === FXM_PREVIEW_HOST || host === OTHER_HOST) {
    return url.pathname === '/'
      ? { status: 200, headers: { 'content-type': 'text/html' }, body: PAGE }
      : { status: 404 }
  }
  if (YOUTUBE_HOSTS.includes(host)) return innertube(req, host, body)
  if (host === GOOGLEVIDEO_HOST || host === GOOGLEVIDEO_OTHER_HOST)
    return googlevideo(req, host, url)
  if (host === SPOTIFY_HOST) return spotify(req, url)
  if (host === CLIENTTOKEN_HOST) return clienttoken(req)
  if (host === PARTNER_HOST || host === SPCLIENT_HOST) return echoingSpotify(req, host, url)
  if (host === LASTFM_HOST && url.pathname.startsWith('/player/station/')) {
    if (req.method === 'OPTIONS') return { status: 200 }
    return json({ playlist: [{ name: 'Mock song', artists: [{ name: 'Mock artist' }] }] })
  }
  return { status: 404 }
}

/** Starts the mock on 127.0.0.1:`port` (strict: fails if the port is taken). */
export async function startMockServer(options: {
  port: number
  key: string
  cert: string
}): Promise<MockServer> {
  const log: LoggedRequest[] = []
  const server = createServer({ key: options.key, cert: options.cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      const url = new URL(req.url ?? '/', `https://${host}`)
      const reply = route(req, host, url, Buffer.concat(chunks).toString('utf8'))
      log.push({
        host,
        method: req.method ?? '',
        path: url.pathname + url.search,
        status: reply.status,
        ...(req.headers.origin ? { origin: req.headers.origin } : {}),
        ...(req.headers.referer ? { referer: req.headers.referer } : {}),
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
        ...(req.headers['access-control-request-headers']
          ? { requestHeaders: req.headers['access-control-request-headers'] }
          : {}),
      })
      send(res, reply)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => resolve())
  })
  return {
    port: options.port,
    log,
    requests: (host, pathPrefix = '') =>
      log.filter((entry) => entry.host === host && entry.path.startsWith(pathPrefix)),
    clearLog: () => {
      log.length = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, reply.headers ?? {})
  res.end(reply.body)
}
