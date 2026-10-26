import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, type Plugin } from 'vite'
import { EMBED_HEADERS } from './embed/headers'

// The embeddable mini-player (stage 5.2): a page of its own, served from /embed/ next to the
// app at /app/, so it can carry its own header rule (no `frame-ancestors`, which lets any site
// frame it, no worker, and only the hosts of YouTube and Internet Archive, which it plays from:
// embed/headers.ts). `vite build -c vite.embed.config.ts` writes it to dist-embed/; the deploy
// (2.8) builds it with `--outDir` into its /embed/ folder.

const EMBED_ROOT = fileURLToPath(new URL('./embed/', import.meta.url))
const SANDBOX_DIR = fileURLToPath(new URL('./sandbox/', import.meta.url))

/** Every embed path: `/embed/<kind>/<source>:<native ID>`, whose ID may contain dots. */
const EMBED_ROUTE = /^\/embed\/(?:track|album|playlist)\/[^/?#]+\/?(?:[?#].*)?$/
/** The Lite tier's sandbox documents (stage 1.10). */
const SANDBOX_DOCUMENT = /^\/sandbox\/(innertube|userhost)\.html(?:[?#].*)?$/

/**
 * Serves the embed's page for every embed path (the deploy answers the player's addresses with
 * it through `_redirects` rewrites, and any other path under /embed/ with its 404.html copy),
 * and the sandbox documents at /sandbox/, so the Lite tier works on the dev and preview servers.
 * The documents go out without their sandbox header here; their own `<meta>` policy still
 * limits what they can fetch, and the embed frames them with `sandbox="allow-scripts"`.
 *
 * The preview server also sends the deploy's `/embed/*` header rule (`embed/headers.ts`), so a
 * policy violation shows there before it ships. The dev server can't: React's refresh preamble
 * is an inline script.
 */
function embedServer(): Plugin {
  const handle =
    (headers: Readonly<Record<string, string>>): Connect.NextHandleFunction =>
    (req, res: ServerResponse, next) => {
      const url = req.url ?? ''
      const document = SANDBOX_DOCUMENT.exec(url)
      if (document) {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(readFileSync(`${SANDBOX_DIR}${document[1]}.html`))
        return
      }
      if (url.startsWith('/embed/')) {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      }
      if (EMBED_ROUTE.test(url)) req.url = '/embed/'
      next()
    }
  return {
    name: 'fxm-embed-server',
    configureServer(server) {
      server.middlewares.use(handle({}))
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle(EMBED_HEADERS))
    },
  }
}

export default defineConfig({
  root: EMBED_ROOT,
  base: '/embed/',
  publicDir: false,
  plugins: [react(), tailwindcss(), embedServer()],
  build: {
    outDir: '../dist-embed',
    emptyOutDir: true,
  },
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
})
