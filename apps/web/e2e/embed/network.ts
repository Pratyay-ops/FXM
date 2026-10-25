/**
 * The embed's browser-test network. The browsers send every request through one local proxy
 * (Playwright's `proxy` launch option, which Chromium and Firefox both honour), and the proxy
 * hands each host to a local server, so the tests use real host names, origins and HTTPS:
 *
 * - **FXM's site** (`fxmusic.pages.dev`, port 6330): the embed's test build under `/embed/`, the
 *   sandbox documents under `/sandbox/`, and a stand-in for the app under `/app/`, each with the
 *   header rules of stage 2.8 (docs/PLAN.md): the app's policy with `frame-ancestors 'none'`,
 *   the same policy without it for `/embed/*`, and the sandbox documents' own policies.
 * - **Another site** (`music-blog.example`, port 6331): a page that embeds the player in an
 *   iframe and drives its postMessage API, plus a frame from a third site next to it.
 * - **The services** (port 6332): InnerTube, googlevideo and Internet Archive mocks.
 *
 * Every other host is refused, and logged, so nothing reaches the internet. The ports are
 * strict: a busy port fails the run (`FXM_EMBED_E2E_PORT` moves all four).
 *
 * The mocks answer as the services did when measured (2026-10-25, docs/ARCHITECTURE.md §3):
 * InnerTube answers CORS-simple POSTs from an opaque origin with `Access-Control-Allow-Origin:
 * null`, and preflights and named foreign origins with 403; googlevideo serves media to any page
 * without CORS, and the top rung's URL is capped (403 for a range past 1 MiB, as `bytes=0-` is),
 * so the player must fall back to itag 18.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { connect as connectTcp, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxDocumentHeader } from '@fxm/platform'
import { E2E_ARCHIVE_HOST, E2E_MEDIA_HOST } from '../../src/embed/testing/e2e-fixtures'

/** The first of the four ports: the site, the other site, the services, the proxy. */
export const BASE_PORT = Number(process.env.FXM_EMBED_E2E_PORT ?? 6330)
export const PORTS = {
  site: BASE_PORT,
  embedder: BASE_PORT + 1,
  services: BASE_PORT + 2,
  proxy: BASE_PORT + 3,
} as const

export const FXM_HOST = 'fxmusic.pages.dev'
export const FXM = `https://${FXM_HOST}`
/** The site that embeds the player. */
export const EMBEDDER_HOST = 'music-blog.example'
export const EMBEDDER = `https://${EMBEDDER_HOST}`
/** A third site, framed next to the player by the embedding page. */
export const SIBLING_HOST = 'widgets.example'
export const SIBLING = `https://${SIBLING_HOST}`
export const INNERTUBE_HOSTS = ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com']
export const MEDIA_HOST = E2E_MEDIA_HOST
export const ARCHIVE_HOST = E2E_ARCHIVE_HOST

/** The capped URL's cap: 403 for any request that reaches past it. */
export const CAPPED_BYTES = 1024 * 1024

const WEB_DIR = fileURLToPath(new URL('../../', import.meta.url))
/** Where `pnpm e2e:embed` builds the embed with `--mode e2e`. */
export const BUILD_DIR = join(WEB_DIR, 'dist-embed-e2e')
const SANDBOX_DIR = join(WEB_DIR, 'sandbox')

/** The headers stage 2.8 gives every rule. */
const COMMON_HEADERS = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

/**
 * The `/app/*` policy of docs/PLAN.md (stage 2.8), with `script-src 'self'`: the stand-in pages
 * here have no inline script, so the theme script's hash isn't needed.
 */
export const APP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/** The `/embed/*` policy: as `/app/*`, without `frame-ancestors`, so any site may frame it. */
export const EMBED_POLICY = APP_POLICY.replace("; frame-ancestors 'none'", '')

/** A WAV file of silence, 16-bit mono at 22,050 Hz: about 44 kB a second. */
function silentWav(bytes: number): Buffer {
  const samples = bytes - 44
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(22_050, 24)
  header.writeUInt32LE(44_100, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples, 40)
  return Buffer.concat([header, Buffer.alloc(samples)])
}

/** The mock media: 1.5 MiB (about 35 s), so a capped URL fails on the first request. */
const MEDIA = silentWav(1.5 * 1024 * 1024)

/** One request the network saw. */
export interface LogEntry {
  /** `connect` for a proxy CONNECT, `http` for a request a server answered. */
  readonly kind: 'connect' | 'http'
  readonly host: string
  /** For `connect`: whether the proxy passed it to a server or refused it. */
  readonly decision?: 'served' | 'refused'
  readonly method?: string
  readonly path?: string
  readonly status?: number
  readonly origin?: string
  readonly referer?: string
  readonly range?: string
  readonly contentType?: string
  readonly body?: string
}

/** What the mocks do; tests change it. */
export interface NetworkState {
  /** InnerTube stops answering opaque origins, as if YouTube closed the Lite tier's path. */
  refuseOpaque: boolean
}

/** The running network. */
export interface TestNetwork {
  /** The proxy's address, for Playwright's `proxy` option. */
  readonly proxy: string
  readonly state: NetworkState
  readonly log: LogEntry[]
  /** Requests a server answered, to `host`, optionally under a path. */
  requests(host: string, pathPrefix?: string): LogEntry[]
  /** Hosts the proxy refused. */
  refused(): string[]
  /** Clears the log and resets the state. */
  reset(): void
  close(): Promise<void>
}

type Reply = { status: number; headers?: Record<string, string>; body?: string | Buffer }

const json = (value: unknown, headers: Record<string, string> = {}): Reply => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  body: JSON.stringify(value),
})

const html = (body: string, headers: Record<string, string> = {}): Reply => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body,
})

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** The stand-in for the app at `/app/`, under the app's policy. */
const APP_STAND_IN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FXM</title></head>
<body><p id="app">The FXM app</p></body></html>
`

/**
 * The page on another site. It frames the player (`?embed=<path and query>`), with the
 * attributes the share dialog's code has, and a frame of a third site next to it. Its script
 * keeps every message from the player, posts what a test asks to it, and says hello when the
 * player's frame has loaded (unless `?hello=0`).
 */
function embedderPage(url: URL): string {
  const embed = url.searchParams.get('embed') ?? '/embed/track/ytm:none'
  const frameUrl = new URL(embed, FXM).href
  const height = url.searchParams.get('height') ?? '232'
  const hello = url.searchParams.get('hello') !== '0'
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>A music blog</title>
  <style>body { font-family: sans-serif; margin: 16px; background: #fafafa; } iframe { display: block; margin-bottom: 12px; }</style></head>
  <body>
    <h1>A post with a song</h1>
    <iframe id="player" title="FXM player" src="${frameUrl}" width="100%" height="${height}"
      style="border:0;border-radius:12px" allow="autoplay" loading="lazy"></iframe>
    <iframe id="sibling" title="Widget" src="${SIBLING}/sibling.html" width="300" height="40" style="border:0"></iframe>
    <button id="page-button" type="button">A button on the blog</button>
    <script>
      window.received = []
      addEventListener('message', (event) => {
        if (event.origin !== ${JSON.stringify(FXM)}) return
        window.received.push(event.data)
      })
      const player = document.getElementById('player')
      window.sendToPlayer = (message, targetOrigin = ${JSON.stringify(FXM)}) =>
        player.contentWindow.postMessage(message, targetOrigin)
      window.hello = () => window.sendToPlayer({ type: 'fxm-embed:hello', protocol: 1 })
      ${hello ? "player.addEventListener('load', () => window.hello())" : ''}
    </script>
  </body>
</html>
`
}

/** The third site's frame: it posts whatever a test asks to the player next to it. */
const SIBLING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Widget</title></head>
<body>
  <script>
    window.sendToPlayer = (message) => parent.frames[0].postMessage(message, ${JSON.stringify(FXM)})
  </script>
</body></html>
`

/** InnerTube, as measured: opaque origins get `ACAO: null`, preflights and named origins 403. */
function innerTube(req: IncomingMessage, url: URL, body: string, state: NetworkState): Reply {
  const origin = req.headers.origin
  const forbidden: Reply = {
    status: 403,
    headers: { 'content-type': 'text/html' },
    body: 'Forbidden',
  }
  if (req.method === 'OPTIONS') return forbidden
  if (origin === 'null' && state.refuseOpaque) return forbidden
  const youtube = origin === 'https://www.youtube.com' || origin === 'https://music.youtube.com'
  if (origin !== undefined && origin !== 'null' && !youtube) return forbidden
  if (req.method !== 'POST') return { status: 405 }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(body) as Record<string, unknown>
  } catch {
    return json({ error: { code: 400, message: 'Invalid JSON payload' } })
  }
  const cors = { 'access-control-allow-origin': origin ?? '*', vary: 'Origin' }
  const responseContext = { visitorData: 'CgtFMmVWaXNpdG9yKMDE' }
  const client = (payload.context as { client?: { clientName?: unknown } } | undefined)?.client
  switch (url.pathname) {
    case '/youtubei/v1/music/get_search_suggestions':
      return json({ responseContext, contents: [] }, cors)
    case '/youtubei/v1/player': {
      const videoId = typeof payload.videoId === 'string' ? payload.videoId : ''
      const media = (itag: number, fxm: 'capped' | 'full') =>
        `https://${MEDIA_HOST}/videoplayback?id=${encodeURIComponent(videoId)}&itag=${itag}&fxm=${fxm}`
      const streamingData =
        client?.clientName === 'ANDROID'
          ? { formats: [{ itag: 18, url: media(18, 'full'), mimeType: 'video/mp4' }] }
          : {
              adaptiveFormats: [
                { itag: 251, url: media(251, 'capped'), mimeType: 'audio/webm; codecs="opus"' },
              ],
            }
      return json(
        {
          responseContext,
          playabilityStatus: { status: 'OK' },
          videoDetails: { videoId, lengthSeconds: '35' },
          streamingData,
        },
        cors,
      )
    }
    default:
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' }
  }
}

/** Media for any page, without CORS; ranges as asked, and capped URLs fail past their cap. */
function media(req: IncomingMessage, capped: boolean): Reply {
  const headers: Record<string, string> = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'cross-origin-resource-policy': 'cross-origin',
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), MEDIA.length - 1) : MEDIA.length - 1
  if (capped && end >= CAPPED_BYTES)
    return { status: 403, headers: { 'content-type': 'text/plain' } }
  if (!range) return { status: 200, headers, body: MEDIA }
  headers['content-range'] = `bytes ${start}-${end}/${MEDIA.length}`
  return { status: 206, headers, body: MEDIA.subarray(start, end + 1) }
}

function selfSignedCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fxm-embed-e2e-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2']
    args.push('-subj', '/CN=fxm-embed-e2e', '-keyout', key, '-out', cert)
    execFileSync('openssl', args, { stdio: 'ignore' })
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A file of the embed's build, or `undefined` outside it. */
function buildFile(path: string): Buffer | undefined {
  const relative = normalize(path).replace(/^([/\\])+/, '')
  if (relative.startsWith('..')) return undefined
  const file = join(BUILD_DIR, relative)
  return existsSync(file) ? readFileSync(file) : undefined
}

/** Starts the network: four servers on 127.0.0.1, failing if a port is taken. */
export async function startTestNetwork(): Promise<TestNetwork> {
  if (!existsSync(join(BUILD_DIR, 'index.html'))) {
    throw new Error(`No embed build in ${BUILD_DIR}: run \`pnpm --filter @fxm/web e2e:embed\``)
  }
  const log: LogEntry[] = []
  const state: NetworkState = { refuseOpaque: false }
  const embedIndex = readFileSync(join(BUILD_DIR, 'index.html'))
  const documents = new Map<string, { html: string; policy: string }>()
  for (const kind of ['innertube', 'userhost'] as const) {
    const source = readFileSync(join(SANDBOX_DIR, `${kind}.html`), 'utf8')
    documents.set(`/sandbox/${kind}.html`, {
      html: source,
      policy: await sandboxDocumentHeader(kind, source),
    })
  }

  /** FXM's site, as stage 2.8 deploys it. */
  function site(url: URL): Reply {
    const document = documents.get(url.pathname)
    if (document !== undefined) {
      return html(document.html, { 'content-security-policy': document.policy, ...COMMON_HEADERS })
    }
    if (url.pathname.startsWith('/embed/')) {
      const headers = { 'content-security-policy': EMBED_POLICY, ...COMMON_HEADERS }
      if (url.pathname.startsWith('/embed/assets/')) {
        const file = buildFile(url.pathname.slice('/embed/'.length))
        if (file === undefined) return { status: 404, headers }
        const type = CONTENT_TYPES[extname(url.pathname)] ?? 'application/octet-stream'
        return { status: 200, headers: { 'content-type': type, ...headers }, body: file }
      }
      // Every other embed path gets the page, as Pages serves embed/404.html (a copy of it).
      return html(embedIndex.toString('utf8'), headers)
    }
    if (url.pathname === '/app/' || url.pathname.startsWith('/app/')) {
      return html(APP_STAND_IN, { 'content-security-policy': APP_POLICY, ...COMMON_HEADERS })
    }
    return { status: 404, headers: COMMON_HEADERS }
  }

  function embedder(host: string, url: URL): Reply {
    if (host === SIBLING_HOST) {
      return url.pathname === '/sibling.html' ? html(SIBLING_PAGE) : { status: 404 }
    }
    return url.pathname === '/' ? html(embedderPage(url)) : { status: 404 }
  }

  function services(req: IncomingMessage, host: string, url: URL, body: string): Reply {
    if (INNERTUBE_HOSTS.includes(host)) return innerTube(req, url, body, state)
    if (host === MEDIA_HOST && url.pathname === '/videoplayback') {
      return media(req, url.searchParams.get('fxm') === 'capped')
    }
    if (host === ARCHIVE_HOST && url.pathname.startsWith('/download/')) return media(req, false)
    return { status: 404 }
  }

  const { key, cert } = selfSignedCertificate()
  const handler =
    (route: (req: IncomingMessage, host: string, url: URL, body: string) => Reply) =>
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const host = (req.headers.host ?? '').replace(/:\d+$/, '')
        const url = new URL(req.url ?? '/', `https://${host}`)
        const body = Buffer.concat(chunks).toString('utf8')
        const reply = route(req, host, url, body)
        const header = (name: string) => {
          const value = req.headers[name]
          return typeof value === 'string' ? value : undefined
        }
        log.push({
          kind: 'http',
          host,
          method: req.method ?? '',
          path: url.pathname + url.search,
          status: reply.status,
          ...(header('origin') === undefined ? {} : { origin: header('origin') }),
          ...(header('referer') === undefined ? {} : { referer: header('referer') }),
          ...(header('range') === undefined ? {} : { range: header('range') }),
          ...(header('content-type') === undefined ? {} : { contentType: header('content-type') }),
          ...(body === '' ? {} : { body: body.slice(0, 2000) }),
        } as LogEntry)
        res.writeHead(reply.status, reply.headers ?? {})
        res.end(reply.body)
      })
    }

  const servers: Record<'site' | 'embedder' | 'services', Server> = {
    site: createHttpsServer(
      { key, cert },
      handler((_req, _host, url) => site(url)),
    ),
    embedder: createHttpsServer(
      { key, cert },
      handler((_req, host, url) => embedder(host, url)),
    ),
    services: createHttpsServer({ key, cert }, handler(services)),
  }

  /** Which server answers each host. */
  function portFor(host: string): number | undefined {
    if (host === FXM_HOST) return PORTS.site
    if (host === EMBEDDER_HOST || host === SIBLING_HOST) return PORTS.embedder
    if ([...INNERTUBE_HOSTS, MEDIA_HOST, ARCHIVE_HOST].includes(host)) return PORTS.services
    return undefined
  }

  const proxy = createHttpServer((_req, res) => {
    // Plain HTTP through the proxy: nothing the tests use.
    res.writeHead(403)
    res.end()
  })
  const sockets = new Set<Socket>()
  proxy.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    const [host = '', port = '443'] = (req.url ?? '').split(':')
    const target = port === '443' ? portFor(host) : undefined
    if (target === undefined) {
      log.push({ kind: 'connect', host, decision: 'refused' })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    log.push({ kind: 'connect', host, decision: 'served' })
    const upstream = connectTcp(target, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy())
  })

  const listen = (server: Server | ReturnType<typeof createHttpServer>, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
  const started: (Server | ReturnType<typeof createHttpServer>)[] = []
  try {
    for (const [name, server] of Object.entries(servers)) {
      await listen(server, PORTS[name as keyof typeof servers])
      started.push(server)
    }
    await listen(proxy, PORTS.proxy)
    started.push(proxy)
  } catch (error) {
    for (const server of started) server.close()
    throw error
  }

  return {
    proxy: `http://127.0.0.1:${PORTS.proxy}`,
    state,
    log,
    requests: (host, pathPrefix = '') =>
      log.filter(
        (entry) =>
          entry.kind === 'http' && entry.host === host && (entry.path ?? '').startsWith(pathPrefix),
      ),
    refused: () => log.filter((entry) => entry.decision === 'refused').map((entry) => entry.host),
    reset() {
      log.length = 0
      state.refuseOpaque = false
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        for (const server of Object.values(servers)) {
          server.closeAllConnections()
          server.close()
        }
        proxy.closeAllConnections()
        proxy.close(() => resolve())
      }),
  }
}
