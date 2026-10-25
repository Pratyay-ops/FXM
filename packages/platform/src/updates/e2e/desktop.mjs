/**
 * Stage 1.13's done-when in the desktop app itself: the Tauri shell of apps/desktop, built with
 * the e2e harness as its frontend, so its bundled YouTube module has a deliberately broken
 * parser. A local stand-in for FXM's site serves a fixed module, version 2, signed with a
 * throwaway key; the app downloads it, verifies it, loads it from a blob: URL under the
 * desktop CSP (script-src with blob:), and resolves the song it couldn't before.
 *
 * It needs the desktop toolchain (make desktop-setup), builds a debug app (a few minutes the
 * first time), opens a small window for a few seconds, and is not part of `make test`:
 *
 *   scripts/run.sh node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/platform/src/updates/e2e/desktop.mjs
 *
 * Only two things differ from the app's own configuration: the frontend, and connect-src, which
 * also allows the local server (the real app reaches the site through native HTTP, stage 7.2).
 * The app runs under a test identifier and keeps its updates in memory; this script removes the
 * identifier's data folders afterwards. Like `tauri dev`, the unbundled binary's webview keeps
 * its caches in ~/Library/WebKit/fxm and ~/Library/Caches/fxm on macOS.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokenFormatParser, buildYouTubeModule } from '@fxm/sources/youtube/module/build'
import { build } from 'vite'
import { toBase64 } from '../encoding.ts'
import { generateSigningKey, importSigningKey, signUpdate } from '../sign.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = resolve(HERE, '../../../../..')
const DESKTOP = join(REPO, 'apps/desktop')
const PORT = Number(process.env.FXM_E2E_PORT ?? 6020)
const ORIGIN = `http://127.0.0.1:${PORT}`
const IDENTIFIER = 'io.github.pratyayops.fxm.e2e'
const TIMEOUT_MS = 120_000

function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', fail)
    child.once('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited ${code}`)),
    )
  })
}

const work = await mkdtemp(join(tmpdir(), 'fxm-desktop-e2e-'))
let server
let app
try {
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

  // The frontend: the harness, with the broken parser in its bundled module.
  const frontend = join(work, 'frontend')
  await build({
    configFile: false,
    root: HERE,
    base: './',
    logLevel: 'warn',
    publicDir: false,
    plugins: [brokenFormatParser()],
    define: {
      __FXM_E2E_TEST_KEY__: JSON.stringify({
        keyId: key.keyId,
        publicKey: toBase64(key.publicKey),
      }),
      __FXM_E2E_UPDATES_URL__: JSON.stringify(`${ORIGIN}/updates/`),
      __FXM_E2E_REPORT_URL__: JSON.stringify(`${ORIGIN}/report`),
    },
    build: {
      outDir: frontend,
      emptyOutDir: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
      rolldownOptions: { input: join(HERE, 'desktop-harness.html') },
    },
  })
  await writeFile(
    join(frontend, 'index.html'),
    await readFile(join(frontend, 'desktop-harness.html')),
  )

  // The app: apps/desktop with that frontend, the same CSP plus the local server.
  const config = JSON.parse(await readFile(join(DESKTOP, 'src-tauri/tauri.conf.json'), 'utf8'))
  const csp = config.app.security.csp.replace(/connect-src ([^;]*)/u, `connect-src $1 ${ORIGIN}`)
  if (!/script-src[^;]* blob:/u.test(csp))
    throw new Error('The desktop CSP has no blob: in script-src')
  const overrides = join(work, 'tauri.e2e.json')
  await writeFile(
    overrides,
    JSON.stringify({
      identifier: IDENTIFIER,
      productName: 'FXM e2e',
      build: { frontendDist: frontend, beforeBuildCommand: null },
      app: {
        security: { csp },
        windows: [{ label: 'main', title: 'FXM e2e', width: 480, height: 320 }],
      },
    }),
  )
  await run('pnpm', ['exec', 'tauri', 'build', '--debug', '--no-bundle', '--config', overrides], {
    cwd: DESKTOP,
  })

  // The site, and the app's report.
  const site = new Map([
    [`/updates/${module.fileName}`, module.bytes],
    [`/updates/${module.fileName}.sig`, signed.envelope],
  ])
  let received
  const reported = new Promise((done) => {
    received = done
  })
  server = createServer((request, response) => {
    const headers = { 'access-control-allow-origin': '*' }
    const url = new URL(request.url ?? '/', ORIGIN)
    if (request.method === 'GET' && url.pathname === '/report') {
      response.writeHead(204, headers)
      response.end()
      received(url.searchParams.get('body') ?? '{}')
      return
    }
    if (request.method === 'POST' && url.pathname === '/report') {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(204, headers)
        response.end()
        received(body)
      })
      return
    }
    const bytes = site.get(request.url ?? '')
    response.writeHead(bytes === undefined ? 404 : 200, headers)
    response.end(bytes)
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(PORT, '127.0.0.1', done)
  })

  app = spawn(join(DESKTOP, 'src-tauri/target/debug/fxm'), [], { stdio: 'inherit' })
  const timeout = new Promise((_, fail) =>
    setTimeout(() => fail(new Error('The app sent no report')), TIMEOUT_MS).unref(),
  )
  const result = JSON.parse(await Promise.race([reported, timeout]))
  console.log(JSON.stringify(result, null, 2))
  const fixed =
    result.before?.ok === false &&
    result.outcome === 'updated' &&
    result.after?.ok === true &&
    result.moduleOrigin === 'fetched'
  console.log(
    fixed
      ? '✔ The signed module update fixed the broken parser in the desktop app.'
      : '✘ The desktop app did not take the update.',
  )
  process.exitCode = fixed ? 0 : 1
} finally {
  app?.kill()
  server?.close()
  await rm(work, { recursive: true, force: true })
  if (process.platform === 'darwin') {
    for (const folder of ['Application Support', 'Caches', 'WebKit']) {
      await rm(join(homedir(), 'Library', folder, IDENTIFIER), { recursive: true, force: true })
    }
  }
}
