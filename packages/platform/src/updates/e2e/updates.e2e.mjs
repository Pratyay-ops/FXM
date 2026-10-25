/**
 * Stage 1.13's done-when, in real browser engines: an app whose bundled YouTube module has a
 * deliberately broken parser downloads a signed module update, verifies it with WebCrypto's
 * Ed25519 (or the library), loads it from a `blob:` URL under the desktop app's Content Security
 * Policy, and resolves the song it couldn't before, without an app update.
 *
 * A local server on 127.0.0.1:6020 (FXM_E2E_PORT; the port is strict) serves the harness app and
 * plays FXM's static site. Everything is built and signed here, with a throwaway key.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'vite'
import {
  brokenFormatParser,
  buildYouTubeModule,
} from '../../../../sources/src/youtube/module/build.mjs'
import { toBase64 } from '../encoding.ts'
import { generateSigningKey, importSigningKey, signUpdate } from '../sign.ts'

const PORT = Number(process.env.FXM_E2E_PORT ?? 6020)
const ORIGIN = `http://127.0.0.1:${PORT}`
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** The desktop app's policy (apps/desktop/src-tauri/tauri.conf.json), for this local origin. */
const DESKTOP_CSP =
  "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; " +
  "connect-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'"
/** The same policy without blob: in script-src, as the web app's has it. */
const NO_BLOB_CSP = DESKTOP_CSP.replace(" 'wasm-unsafe-eval' blob:", " 'wasm-unsafe-eval'")

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }

let server
let appDir

test.beforeAll(async () => {
  // The update: the fixed module, version 2, signed with a throwaway key.
  const key = await importSigningKey((await generateSigningKey()).pkcs8)
  const module = await buildYouTubeModule({ version: 2 })
  const signed = await signUpdate(key, {
    kind: 'youtube-module',
    version: module.version,
    api: module.api,
    file: module.fileName,
    bytes: module.bytes,
  })
  const tampered = new TextEncoder().encode(module.code.replace('youtubeModule', 'youtubeModulE'))

  // The app: version 1 of the module, built with the broken parser, trusting only that key.
  appDir = await mkdtemp(join(tmpdir(), 'fxm-updates-e2e-'))
  await build({
    configFile: false,
    root: HERE,
    base: './',
    logLevel: 'warn',
    publicDir: false,
    plugins: [brokenFormatParser()],
    define: {
      __FXM_E2E_TEST_KEY__: JSON.stringify({ id: key.keyId, publicKey: toBase64(key.publicKey) }),
    },
    build: {
      outDir: appDir,
      emptyOutDir: true,
      reportCompressedSize: false,
      // The harness holds youtubei.js, like the app: one large chunk is expected.
      chunkSizeWarningLimit: 4096,
      rolldownOptions: { input: join(HERE, 'harness.html') },
    },
  })

  const site = new Map([
    [`/updates/${module.fileName}`, module.bytes],
    [`/updates/${module.fileName}.sig`, signed.envelope],
    [`/tampered/${module.fileName}`, tampered],
    [`/tampered/${module.fileName}.sig`, signed.envelope],
  ])
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN)
    const published = site.get(url.pathname)
    if (published !== undefined) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(published)
      return
    }
    const path = url.pathname === '/' ? '/harness.html' : url.pathname
    try {
      const body = await readFile(join(appDir, path))
      const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }
      if (path.endsWith('.html')) {
        headers['content-security-policy'] =
          url.searchParams.get('csp') === 'web' ? NO_BLOB_CSP : DESKTOP_CSP
      }
      response.writeHead(200, headers)
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', resolve)
  })
})

test.afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  if (appDir) await rm(appDir, { recursive: true, force: true })
})

async function run(page, path, updates) {
  await page.goto(`${ORIGIN}${path}`)
  await page.waitForFunction(() => typeof window.fxmRun === 'function')
  return page.evaluate((updatesPath) => window.fxmRun(updatesPath), updates)
}

test('a signed module update fixes the broken bundled parser, loaded from a blob: URL', async ({
  page,
}) => {
  const result = await run(page, '/', '/updates/')
  expect(result.before).toMatchObject({ ok: false, code: 'Parse' })
  expect(result.outcome).toBe('updated')
  expect(result.problems).toEqual([])
  expect(result.after).toMatchObject({ ok: true, rung: 'visionos', codec: 'opus' })
  expect(result.moduleOrigin).toBe('fetched')
  expect(result.moduleVersion).toBe(2)
  expect(['webcrypto', 'noble']).toContain(result.engine)
})

test('a module whose bytes were changed is refused, and the app keeps its own', async ({
  page,
}) => {
  const result = await run(page, '/', '/tampered/')
  expect(result.outcome).toBe('failed')
  expect(result.problems).toEqual(['hash-mismatch'])
  expect(result.after).toMatchObject({ ok: false, code: 'Parse' })
  expect(result.moduleOrigin).toBe('bundled')
})

test('without blob: in script-src, as on the web, the module can’t load', async ({ page }) => {
  const result = await run(page, '/?csp=web', '/updates/')
  expect(result.outcome).toBe('failed')
  expect(result.problems).toEqual(['load-failed'])
  expect(result.after).toMatchObject({ ok: false, code: 'Parse' })
  expect(result.moduleOrigin).toBe('bundled')
})
