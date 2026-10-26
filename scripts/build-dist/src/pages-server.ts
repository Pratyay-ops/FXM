/**
 * A local stand-in for Cloudflare Pages: serves a composed folder the way Pages' asset server
 * does (wrangler 4.149's copy of it, read 2026-10-26), so the header checks and the Playwright
 * checks can run without deploying.
 *
 * - `/privacy` serves `privacy.html`; `/privacy.html` and `/index.html` redirect (308) to the
 *   extension-less path, and `/app` to `/app/`.
 * - A path no file answers gets the nearest `404.html` with status 404 (a single-page app's
 *   copy of its index.html serves its client-side routes).
 * - Files are looked up by the decoded path, so `/priv%61cy` serves `privacy.html`, but
 *   `_headers` rules match the path as sent, still encoded (measured on a deployment
 *   2026-10-26). Repeated slashes are merged before both, as Cloudflare's edge does.
 * - Every response gets Pages' defaults (`Access-Control-Allow-Origin: *`,
 *   `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`),
 *   then the headers of every `_headers` rule matching the request path, redirects and 404s
 *   included. A header a second rule sets again is joined with a comma, as on Pages.
 *
 * It is an approximation for tests: the deploy workflow checks the real host.
 *
 *   node pages-server.ts [folder] [--port 5800]   (default folder: dist/pages)
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { matchingRules, type ParsedRule, parseHeaders } from './headers-file.ts'
import { isMain, PAGES_DIR } from './paths.ts'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.xz': 'application/x-xz',
}

type Resolution =
  | { kind: 'file'; status: 200 | 404; file: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'missing' }

/** How Pages answers a path, given the folder's files. */
export function resolvePath(dir: string, pathname: string): Resolution {
  const isFile = (path: string) => {
    if (path === '/_headers' || path === '/_redirects') return false
    const file = join(dir, path)
    return file.startsWith(resolve(dir)) && existsSync(file) && statSync(file).isFile()
  }
  const serve = (path: string): Resolution => ({ kind: 'file', status: 200, file: join(dir, path) })
  const redirect = (path: string): Resolution => ({ kind: 'redirect', location: path })
  const notFound = (): Resolution => {
    let cwd = pathname
    while (cwd) {
      cwd = cwd.slice(0, cwd.lastIndexOf('/'))
      if (isFile(`${cwd}/404.html`))
        return { kind: 'file', status: 404, file: join(dir, cwd, '404.html') }
    }
    return isFile('/index.html') ? serve('/index.html') : { kind: 'missing' }
  }

  if (pathname.endsWith('/')) {
    if (isFile(`${pathname}index.html`)) return serve(`${pathname}index.html`)
    if (pathname.endsWith('/index/')) return redirect(pathname.slice(0, -'index/'.length))
    if (isFile(`${pathname.slice(0, -1)}.html`)) return redirect(pathname.slice(0, -1))
    return notFound()
  }
  if (isFile(pathname)) {
    if (!pathname.endsWith('.html')) return serve(pathname)
    const extensionless = pathname.slice(0, -'.html'.length)
    if (extensionless.endsWith('/index')) return redirect(extensionless.slice(0, -'index'.length))
    if (isFile(extensionless) || extensionless === '/') return serve(pathname)
    return redirect(extensionless)
  }
  if (pathname.endsWith('/index')) return redirect(pathname.slice(0, -'index'.length))
  if (isFile(`${pathname}.html`)) return serve(`${pathname}.html`)
  if (isFile(`${pathname}/index.html`)) return redirect(`${pathname}/`)
  return notFound()
}

function applyHeaders(
  response: ServerResponse,
  rules: readonly ParsedRule[],
  pathname: string,
): void {
  const setByRule = new Set<string>()
  for (const rule of matchingRules(rules, pathname)) {
    for (const [name, value] of rule.headers) {
      const previous = response.getHeader(name)
      response.setHeader(name, setByRule.has(name) ? `${previous}, ${value}` : value)
      setByRule.add(name)
    }
  }
}

/** An HTTP server that answers like Cloudflare Pages for the folder. */
export function createPagesServer(dir: string): Server {
  const headersFile = join(dir, '_headers')
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, 'utf8')).rules : []
  return createServer((request, response) => {
    // Prefixed rather than resolved, so `//privacy` stays a path and doesn't become a host.
    const target = request.url ?? '/'
    const url = target.startsWith('/')
      ? new URL(`http://localhost${target}`)
      : new URL(target, 'http://localhost')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }
    const raw = url.pathname.replace(/\/{2,}/g, '/')
    let pathname = raw
    try {
      pathname = decodeURIComponent(raw)
    } catch {
      // Pages keeps the raw path when it can't be decoded.
    }
    const resolution = resolvePath(dir, pathname)
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
    if (resolution.kind === 'redirect') {
      response.statusCode = 308
      response.setHeader(
        'location',
        `${resolution.location.split('/').map(encodeURIComponent).join('/')}${url.search}`,
      )
    } else if (resolution.kind === 'file') {
      response.statusCode = resolution.status
      response.setHeader(
        'content-type',
        CONTENT_TYPES[extname(resolution.file)] ?? 'application/octet-stream',
      )
      response.setHeader('x-content-type-options', 'nosniff')
    } else {
      response.statusCode = 404
    }
    applyHeaders(response, rules, raw)
    if (response.statusCode === 404) response.setHeader('cache-control', 'no-store')
    if (resolution.kind === 'file' && request.method === 'GET')
      response.end(readFileSync(resolution.file))
    else response.end()
  })
}

/** Starts the server on 127.0.0.1, failing when the port is taken (no fallback port). */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolvePromise(typeof address === 'object' && address ? address.port : port)
    })
  })
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2)
  const portFlag = args.indexOf('--port')
  const port = Number(portFlag === -1 ? (process.env.FXM_PREVIEW_PORT ?? 5800) : args[portFlag + 1])
  if (portFlag !== -1) args.splice(portFlag, 2)
  const dir = resolve(args[0] ?? PAGES_DIR)
  if (!existsSync(join(dir, '_headers'))) {
    console.error(`${dir} has no _headers file: run make dist first`)
    process.exit(1)
  }
  listen(createPagesServer(dir), port).then(
    (actual) => console.log(`Serving ${dir} like Cloudflare Pages at http://127.0.0.1:${actual}/`),
    (error: Error) => {
      console.error(`Can't listen on port ${port}: ${error.message}`)
      process.exit(1)
    },
  )
}
