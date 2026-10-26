/**
 * Serves the locally built ffmpeg core at the app's `ffmpeg/` path on Vite's dev and preview
 * servers, so "Save to device" converts there as in the deployed app (`make dist` copies the
 * core into the app instead). Without a local build (`make ffmpeg-wasm`) the files answer 404,
 * and the app says that converting isn't available, as a deploy without the core would.
 *
 * @module
 */
import { createReadStream, existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CORE_FILES, coreDistDir } from './core-build.ts'

const TYPES: Readonly<Record<string, string>> = {
  [CORE_FILES.script]: 'text/javascript; charset=utf-8',
  [CORE_FILES.wasm]: 'application/wasm',
  [CORE_FILES.manifest]: 'application/json; charset=utf-8',
}

/** A Connect-style middleware, as Vite's servers take them. */
export type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void

/** Answers `<base>ffmpeg/<core file>` from `dir`; everything else goes on. */
export function ffmpegCoreMiddleware(
  base: string | (() => string),
  dir: () => string = coreDistDir,
): Middleware {
  return (request, response, next) => {
    const root = typeof base === 'function' ? base() : base
    const prefix = `${root.endsWith('/') ? root : `${root}/`}ffmpeg/`
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith(prefix)) {
      next()
      return
    }
    const name = path.slice(prefix.length)
    const type = Object.hasOwn(TYPES, name) ? TYPES[name] : undefined
    const file = type === undefined ? undefined : join(dir(), name)
    if (type === undefined || file === undefined || !existsSync(file)) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.end(
        type === undefined ? 'Not found' : 'No ffmpeg core is built here: run make ffmpeg-wasm',
      )
      return
    }
    response.statusCode = 200
    response.setHeader('Content-Type', type)
    response.setHeader('Cache-Control', 'no-cache')
    createReadStream(file).pipe(response)
  }
}

/** The parts of Vite's dev and preview servers the plugin uses. */
interface ServerLike {
  readonly middlewares: { use(middleware: Middleware): unknown }
}

/**
 * A Vite plugin serving the local core on the dev and preview servers, under the app's base
 * (`/app/` on the web, `/` for the desktop app's dev server).
 */
export function ffmpegCoreDevPlugin() {
  let base = '/'
  let dir: string | undefined
  const middleware = ffmpegCoreMiddleware(
    () => base,
    () => {
      dir ??= coreDistDir()
      return dir
    },
  )
  return {
    name: 'fxm-ffmpeg-core',
    configResolved(config: { readonly base: string }) {
      base = config.base
    },
    configureServer(server: ServerLike) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server: ServerLike) {
      server.middlewares.use(middleware)
    },
  }
}
