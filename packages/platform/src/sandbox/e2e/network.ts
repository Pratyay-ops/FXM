/**
 * The browser tests' network. Every request the browsers make goes through one local HTTP proxy
 * (Playwright's `proxy` launch option, which Chromium and Firefox both honour), so the tests use
 * the real host names, origins and HTTPS, on any browser:
 *
 * - a `CONNECT` to a host the tests serve is handed to an in-process HTTPS server with a
 *   throwaway self-signed certificate (the tests ignore certificate errors);
 * - in live mode, a `CONNECT` to YouTube's API hosts or to googlevideo is tunnelled to the real
 *   host, so only those reach the internet;
 * - everything else is refused, and logged, so a test can show that nothing tried to reach it.
 *
 * The mocks reproduce what was measured against the live services on 2026-10-25:
 *
 * - **InnerTube** answers CORS-simple POSTs from an opaque origin (`Origin: null`) with 200 and
 *   `Access-Control-Allow-Origin: null`, preflights with 403, and named foreign origins with 403
 *   and no CORS headers.
 * - **googlevideo** serves media to any page (`Cross-Origin-Resource-Policy: cross-origin`) but
 *   sends no `Access-Control-Allow-Origin`. A capped URL (a VISIONOS stand-in here) answers 403 to
 *   a request that reaches past 1 MiB, as `bytes=0-` does; a full one (itag 18) serves every
 *   range.
 * - **A user host** (an Invidious instance) answers with `Access-Control-Allow-Origin: *`.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectTcp, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { sandboxDocumentHeader } from '../csp.ts'
import type { SandboxDocumentKind } from '../document.ts'

/** The FXM origin the tests serve the app's side and the sandbox documents from. */
export const FXM_HOST = 'fxm-music.pages.dev'
export const FXM = `https://${FXM_HOST}`
/** Another site, which frames the sandbox documents itself. */
export const OTHER_HOST = 'not-fxm.example'
/** A user host: an Invidious instance the user typed in Settings. */
export const USER_HOST = 'invidious.example'
/** A host nothing may reach; the proxy refuses it. */
export const BLOCKED_HOST = 'blocked.example'
export const INNERTUBE_HOSTS = ['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com']
/** The mock media server. */
export const GOOGLEVIDEO_HOST = 'rr1---sn-mock.googlevideo.com'

/** The cap of a capped stream URL: 403 for any request that reaches past it. */
export const CAPPED_BYTES = 1024 * 1024

/** Responses at least this large: 9 MiB, over `innertube.html`'s 8 MiB cap. */
const HUGE_BYTES = 9 * 1024 * 1024
/** How long the mock waits before answering a slow request. */
const SLOW_MS = 3000

const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const SANDBOX_DIR = fileURLToPath(new URL('../../../../../apps/web/sandbox/', import.meta.url))
const HARNESS_ENTRY = fileURLToPath(new URL('./harness/harness.ts', import.meta.url))

/** A WAV file of silence, 16-bit mono at 22,050 Hz: about 44 kB a second. */
export function silentWav(bytes: number): Buffer {
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

/** The mock media: 1.5 MiB, so a capped URL fails on the browser's first request. */
const MEDIA = silentWav(1.5 * 1024 * 1024)

/** One request the network saw. */
export interface LogEntry {
  /** `connect` for a proxy CONNECT, `http` for a request a mock answered. */
  readonly kind: 'connect' | 'http'
  readonly host: string
  /** For `connect`: what the proxy did. */
  readonly decision?: 'served' | 'tunnelled' | 'refused'
  readonly method?: string
  readonly path?: string
  readonly status?: number
  readonly origin?: string
  readonly referer?: string
  readonly cookie?: string
  readonly contentType?: string
  readonly range?: string
  readonly requestHeaders?: string
  readonly body?: string
}

/** What the mocks do, changed by tests. */
export interface NetworkState {
  /** `mock`: the mocks answer YouTube's hosts; `live`: the proxy tunnels them to YouTube. */
  mode: 'mock' | 'live'
  /** InnerTube stops answering opaque origins, as if YouTube closed the Lite tier's path. */
  refuseOpaque: boolean
}

/** The running network. */
export interface TestNetwork {
  /** The proxy's address, for Playwright's `proxy` option. */
  readonly proxy: string
  readonly state: NetworkState
  readonly log: LogEntry[]
  /** Requests a mock answered, to a host and optionally under a path. */
  requests(host: string, pathPrefix?: string): LogEntry[]
  /** CONNECTs the proxy refused. */
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

const page = (html: string, headers: Record<string, string> = {}): Reply => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body: html,
})

/** The headers every FXM page gets from stage 2.8's rules. */
const COMMON_HEADERS = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

/**
 * The app's policy, cut down to what the harness needs: its own script only, frames from its
 * own origin (the sandbox documents), media from anywhere over HTTPS, and InnerTube for the
 * FXM Connect tier, as `/app/*` has it.
 */
const HARNESS_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "media-src 'self' blob: https:",
  `connect-src 'self' ${INNERTUBE_HOSTS.map((host) => `https://${host}`).join(' ')} https://*.googlevideo.com`,
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

const HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>FXM sandbox harness</title></head>
  <body><script src="/harness.js"></script></body>
</html>
`

/** A page on another site that frames a sandbox document without the sandbox attribute. */
function otherSitePage(kind: SandboxDocumentKind): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Another site</title></head>
  <body>
    <iframe id="target" src="${FXM}/sandbox/${kind}.html"></iframe>
    <script>
      window.received = []
      addEventListener('message', (event) => {
        window.received.push({ origin: event.origin, data: event.data })
      })
      window.probe = async (requests) => {
        const target = document.getElementById('target').contentWindow
        const channel = new MessageChannel()
        const portReplies = []
        channel.port1.onmessage = (event) => portReplies.push(event.data)
        target.postMessage({ type: 'fxm-sandbox:connect', protocol: 1 }, '*', [channel.port2])
        for (const request of requests) {
          channel.port1.postMessage(request)
          target.postMessage(request, '*')
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return { windowMessages: window.received, portReplies }
      }
    </script>
  </body>
</html>
`
}

/**
 * An FXM page with the InnerTube document and a same-origin helper frame next to it: the helper
 * is at the FXM origin, but it is not the document's parent.
 */
const SIBLING_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Siblings</title></head>
  <body>
    <iframe sandbox="allow-scripts" src="/sandbox/innertube.html"></iframe>
    <iframe src="/helper.html"></iframe>
    <script>
      // The document's real parent, connecting as the transport does.
      window.probe = async (request) => {
        const channel = new MessageChannel()
        const replies = []
        channel.port1.onmessage = (event) => replies.push(event.data)
        frames[0].postMessage({ type: 'fxm-sandbox:connect', protocol: 1 }, '*', [channel.port2])
        channel.port1.postMessage(request)
        for (let waited = 0; replies.length === 0 && waited < 5000; waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return replies.map((reply) => ({ ...reply, body: undefined }))
      }
    </script>
  </body>
</html>
`

const HELPER_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Helper</title></head>
  <body>
    <script>
      window.probe = async (request) => {
        const target = parent.frames[0]
        const channel = new MessageChannel()
        const replies = []
        channel.port1.onmessage = (event) => replies.push(event.data)
        target.postMessage({ type: 'fxm-sandbox:connect', protocol: 1 }, '*', [channel.port2])
        channel.port1.postMessage(request)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return replies
      }
    </script>
  </body>
</html>
`

/** The InnerTube mock's answer to an API call, by path and payload. */
async function innerTubeAnswer(path: string, payload: Record<string, unknown>): Promise<Reply> {
  const responseContext = { visitorData: 'CgtNb2NrVmlzaXRvcijMwbS5Bg%3D%3D' }
  const client = (payload.context as { client?: { clientName?: string } } | undefined)?.client
  switch (path) {
    case '/youtubei/v1/search':
      return json({ responseContext, mock: 'search', query: payload.query ?? null })
    case '/youtubei/v1/music/get_search_suggestions':
      return json({ responseContext, mock: 'suggestions', input: payload.input ?? null })
    case '/youtubei/v1/next':
      return json({ responseContext, mock: 'next', videoId: payload.videoId ?? null })
    case '/youtubei/v1/browse': {
      if (payload.browseId === 'FXM_HUGE') {
        return json({ responseContext, padding: 'x'.repeat(HUGE_BYTES) })
      }
      if (payload.browseId === 'FXM_SLOW') {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
      }
      return json({ responseContext, mock: 'browse', browseId: payload.browseId ?? null })
    }
    case '/youtubei/v1/player': {
      const videoId = String(payload.videoId ?? '')
      const media = (fxm: string, itag: number) =>
        `https://${GOOGLEVIDEO_HOST}/videoplayback?id=${encodeURIComponent(videoId)}&itag=${itag}&c=${client?.clientName}&fxm=${fxm}`
      const streamingData =
        client?.clientName === 'ANDROID'
          ? { formats: [{ itag: 18, url: media('full', 18), mimeType: 'video/mp4' }] }
          : {
              adaptiveFormats: [
                { itag: 251, url: media('capped', 251), mimeType: 'audio/webm; codecs="opus"' },
              ],
            }
      return json({
        responseContext,
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId, title: 'Mock song', lengthSeconds: '35' },
        streamingData,
      })
    }
    default:
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' }
  }
}

/** InnerTube, as measured: opaque origins get `ACAO: null`, preflights and named origins 403. */
async function innerTube(
  req: IncomingMessage,
  url: URL,
  body: string,
  state: NetworkState,
): Promise<Reply> {
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
  const reply = await innerTubeAnswer(url.pathname, payload)
  return {
    ...reply,
    headers: {
      ...reply.headers,
      ...(origin === undefined ? {} : { 'access-control-allow-origin': origin }),
      vary: 'Origin',
    },
  }
}

/** googlevideo, as measured: media for anyone, no CORS, and capped URLs fail past their cap. */
function googlevideo(req: IncomingMessage, url: URL): Reply {
  const headers: Record<string, string> = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'cross-origin-resource-policy': 'cross-origin',
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), MEDIA.length - 1) : MEDIA.length - 1
  if (url.searchParams.get('fxm') === 'capped' && end >= CAPPED_BYTES) {
    return { status: 403, headers: { 'content-type': 'text/plain' } }
  }
  if (!range) return { status: 200, headers, body: MEDIA }
  headers['content-range'] = `bytes ${start}-${end}/${MEDIA.length}`
  return { status: 206, headers, body: MEDIA.subarray(start, end + 1) }
}

/** An Invidious instance: CORS for anyone. */
async function userHost(url: URL): Promise<Reply> {
  const cors = { 'access-control-allow-origin': '*' }
  if (url.pathname === '/big') {
    return {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', ...cors },
      body: Buffer.alloc(5 * 1024 * 1024),
    }
  }
  if (url.pathname === '/slow') await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
  return json({ software: { name: 'invidious', version: 'mock' }, path: url.pathname }, cors)
}

function selfSignedCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fxm-sandbox-e2e-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=fxm-sandbox-e2e',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The harness page's script: the platform package, bundled for the browser. */
async function bundleHarness(): Promise<string> {
  const bundle = await rolldown({ input: HARNESS_ENTRY, platform: 'browser', cwd: PACKAGE_DIR })
  try {
    const { output } = await bundle.generate({ format: 'iife' })
    const [chunk] = output
    if (chunk === undefined || chunk.type !== 'chunk') throw new Error('No harness bundle')
    return chunk.code
  } finally {
    await bundle.close()
  }
}

/** Starts the network: the proxy listens on 127.0.0.1:`port`, failing if the port is taken. */
export async function startTestNetwork(options: { port: number }): Promise<TestNetwork> {
  const log: LogEntry[] = []
  const state: NetworkState = { mode: 'mock', refuseOpaque: false }
  const sandboxDocuments = new Map<string, { html: string; policy: string }>()
  for (const kind of ['innertube', 'userhost'] as const) {
    const html = readFileSync(join(SANDBOX_DIR, `${kind}.html`), 'utf8')
    sandboxDocuments.set(`/sandbox/${kind}.html`, {
      html,
      policy: await sandboxDocumentHeader(kind, html),
    })
  }
  const harness = await bundleHarness()

  const served = (host: string) =>
    [FXM_HOST, OTHER_HOST].includes(host) ||
    (state.mode === 'mock' && [...INNERTUBE_HOSTS, GOOGLEVIDEO_HOST, USER_HOST].includes(host))
  const tunnelled = (host: string) =>
    state.mode === 'live' && (INNERTUBE_HOSTS.includes(host) || host.endsWith('.googlevideo.com'))

  async function route(req: IncomingMessage, host: string, url: URL, body: string): Promise<Reply> {
    if (host === FXM_HOST) {
      const document = sandboxDocuments.get(url.pathname)
      if (document !== undefined) {
        return page(document.html, {
          'content-security-policy': document.policy,
          ...COMMON_HEADERS,
        })
      }
      if (url.pathname === '/harness.html') {
        return page(HARNESS_HTML, { 'content-security-policy': HARNESS_POLICY, ...COMMON_HEADERS })
      }
      if (url.pathname === '/harness.js') {
        return {
          status: 200,
          headers: { 'content-type': 'text/javascript', ...COMMON_HEADERS },
          body: harness,
        }
      }
      if (url.pathname === '/sibling.html') return page(SIBLING_HTML, COMMON_HEADERS)
      if (url.pathname === '/helper.html') return page(HELPER_HTML, COMMON_HEADERS)
      return { status: 404 }
    }
    if (host === OTHER_HOST) {
      const kind = url.searchParams.get('document') === 'userhost' ? 'userhost' : 'innertube'
      return url.pathname === '/frame.html' ? page(otherSitePage(kind)) : { status: 404 }
    }
    if (INNERTUBE_HOSTS.includes(host)) return innerTube(req, url, body, state)
    if (host === GOOGLEVIDEO_HOST) return googlevideo(req, url)
    if (host === USER_HOST) return userHost(url)
    return { status: 404 }
  }

  const { key, cert } = selfSignedCertificate()
  const https = createHttpsServer({ key, cert }, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      const url = new URL(req.url ?? '/', `https://${host}`)
      const body = Buffer.concat(chunks).toString('utf8')
      void route(req, host, url, body).then((reply) => {
        const header = (name: string) => {
          const value = req.headers[name]
          return typeof value === 'string'
            ? { [name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())]: value }
            : {}
        }
        log.push({
          kind: 'http',
          host,
          method: req.method ?? '',
          path: url.pathname + url.search,
          status: reply.status,
          ...header('origin'),
          ...header('referer'),
          ...header('cookie'),
          ...header('range'),
          ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
          ...(req.headers['access-control-request-headers']
            ? { requestHeaders: req.headers['access-control-request-headers'] }
            : {}),
          ...(body === '' ? {} : { body: body.slice(0, 2000) }),
        })
        res.writeHead(reply.status, reply.headers ?? {})
        res.end(reply.body)
      })
    })
  })

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
    if (port === '443' && served(host)) {
      log.push({ kind: 'connect', host, decision: 'served' })
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) socket.unshift(head)
      https.emit('connection', socket)
    } else if (port === '443' && tunnelled(host)) {
      log.push({ kind: 'connect', host, decision: 'tunnelled' })
      const upstream = connectTcp(443, host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
    } else {
      log.push({ kind: 'connect', host, decision: 'refused' })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(options.port, '127.0.0.1', () => resolve())
  })

  return {
    proxy: `http://127.0.0.1:${options.port}`,
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
      state.mode = 'mock'
      state.refuseOpaque = false
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        https.close()
        proxy.closeAllConnections()
        proxy.close(() => resolve())
      }),
  }
}
