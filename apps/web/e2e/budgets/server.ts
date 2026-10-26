import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  createServer,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  request,
} from 'node:http'
import { createSecureServer, type ServerHttp2Session } from 'node:http2'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { brotli } from './chunks'

// A front for the Pages stand-in (scripts/build-dist/src/pages-server.ts) that answers the way
// Cloudflare Pages does on the wire: over HTTP/2 and TLS, with text compressed as Pages compresses
// it for Chromium (brotli; gzip for a client without it), and that counts the bytes each answer
// sends. The stand-in alone speaks uncompressed HTTP/1.1: over it a first load would wait for six
// connections and for every byte of its scripts, which no visitor of the deployed app does. A
// second front speaks plain HTTP/1.1, for the service worker, which Chromium doesn't run on an
// origin whose certificate it doesn't trust.

/** One answer a front sent. */
export interface Transfer {
  readonly path: string
  readonly status: number
  /** The body's bytes as sent, compressed or not. */
  readonly bytes: number
  readonly encoding: 'br' | 'gzip' | 'identity'
  /** The HTTP version the request came over: `2.0` from the secure front, `1.1` otherwise. */
  readonly protocol: string
}

/** The running fronts. */
export interface BudgetServer {
  /** The HTTP/2 front's origin, `https://127.0.0.1:<port>`; its certificate is self-signed. */
  readonly secure: string
  /** The plain HTTP/1.1 front's origin, `http://127.0.0.1:<port>`. */
  readonly plain: string
  /** Every answer sent so far, in order: empty it to measure one load. */
  readonly transfers: Transfer[]
  close(): Promise<void>
}

/** What Cloudflare compresses: text, scripts, JSON, manifests, SVG and WebAssembly. */
const COMPRESSIBLE =
  /^(text\/|application\/(javascript|json|manifest\+json|xml|wasm)|image\/svg\+xml)/u

/** Headers of one connection, which HTTP/2 refuses to carry, and the length, set anew. */
const DROPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

/** How an answer goes out, for the request's `Accept-Encoding` and the answer's type. */
function encodingFor(accepted: string, type: string, length: number): Transfer['encoding'] {
  if (length === 0 || !COMPRESSIBLE.test(type)) return 'identity'
  if (/\bbr\b/u.test(accepted)) return 'br'
  return /\bgzip\b/u.test(accepted) ? 'gzip' : 'identity'
}

/** What the fronts read of a request, HTTP/1.1's or HTTP/2's. */
interface Incoming {
  readonly url?: string | undefined
  readonly method?: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly httpVersion: string
}

/** What the fronts do with a response, HTTP/1.1's or HTTP/2's. */
interface Outgoing {
  writeHead(status: number, headers: OutgoingHttpHeaders): unknown
  end(body?: Uint8Array | string): unknown
}

/** Answers each request from the stand-in at `upstream`, compressed, and records the answer. */
function forward(upstream: string, transfers: Transfer[]) {
  return (incoming: Incoming, outgoing: Outgoing) => {
    const path = incoming.url ?? '/'
    const proxied = request(`${upstream}${path}`, { method: incoming.method }, (answer) => {
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        const body = Buffer.concat(chunks)
        const encoding = encodingFor(
          String(incoming.headers['accept-encoding'] ?? ''),
          String(answer.headers['content-type'] ?? ''),
          body.length,
        )
        const sent =
          encoding === 'br'
            ? brotli(body)
            : encoding === 'gzip'
              ? gzipSync(body, { level: 9 })
              : body
        const headers: OutgoingHttpHeaders = {}
        for (const [name, value] of Object.entries(answer.headers)) {
          if (!DROPPED_HEADERS.has(name)) headers[name] = value
        }
        if (encoding !== 'identity') headers['content-encoding'] = encoding
        headers.vary = 'accept-encoding'
        headers['content-length'] = String(sent.length)
        const status = answer.statusCode ?? 502
        outgoing.writeHead(status, headers)
        outgoing.end(incoming.method === 'HEAD' ? undefined : sent)
        transfers.push({
          path,
          status,
          bytes: sent.length,
          encoding,
          protocol: incoming.httpVersion,
        })
      })
    })
    proxied.on('error', (error) => {
      outgoing.writeHead(502, { 'content-type': 'text/plain' })
      outgoing.end(`The Pages stand-in didn't answer: ${error.message}`)
    })
    proxied.end()
  }
}

/** A self-signed certificate for 127.0.0.1, made with openssl in a temporary folder. */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'fxm-budgets-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2'],
        ...['-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert],
      ],
      { stdio: 'ignore', env: { ...process.env, RANDFILE: join(dir, '.rnd') } },
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Listens on 127.0.0.1, failing when the port is taken rather than measuring another server. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

/**
 * Starts the fronts on `ports.secure` (HTTP/2) and `ports.plain` (HTTP/1.1), both answering from
 * the Pages stand-in at `upstream` (`http://127.0.0.1:<port>`).
 */
export async function startBudgetServer(
  upstream: string,
  ports: { readonly secure: number; readonly plain: number },
): Promise<BudgetServer> {
  const transfers: Transfer[] = []
  const handle = forward(upstream, transfers)
  const secure = createSecureServer({ ...certificate(), allowHTTP1: true }, handle)
  const plain = createServer(handle)
  // Chromium keeps its connections open: close() ends them rather than wait for the browser.
  const sessions = new Set<ServerHttp2Session>()
  secure.on('session', (session: ServerHttp2Session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  })
  await listen(secure, ports.secure)
  try {
    await listen(plain, ports.plain)
  } catch (error) {
    secure.close()
    throw error
  }
  return {
    secure: `https://127.0.0.1:${ports.secure}`,
    plain: `http://127.0.0.1:${ports.plain}`,
    transfers,
    close: async () => {
      const closed = [secure, plain].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      )
      for (const session of sessions) session.destroy()
      plain.closeAllConnections()
      await Promise.all(closed)
    },
  }
}
