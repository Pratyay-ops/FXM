import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, type Plugin } from 'vite'

// The embeddable mini-player (stage 5.2): a page of its own, served from /embed/ next to the
// app at /app/, so it can carry its own header rule (the app's policy without
// `frame-ancestors`, which lets any site frame it). `vite build -c vite.embed.config.ts`
// writes it to dist-embed/; the deploy (2.8) builds it with `--outDir` into its /embed/ folder.

const EMBED_ROOT = fileURLToPath(new URL('./embed/', import.meta.url))
const SANDBOX_DIR = fileURLToPath(new URL('./sandbox/', import.meta.url))

/** Every embed path: `/embed/<kind>/<source>:<native ID>`, whose ID may contain dots. */
const EMBED_ROUTE = /^\/embed\/(?:track|album|playlist)\/[^/?#]+\/?(?:[?#].*)?$/
/** The Lite tier's sandbox documents (stage 1.10). */
const SANDBOX_DOCUMENT = /^\/sandbox\/(innertube|userhost)\.html(?:[?#].*)?$/

/**
 * Serves the embed's page for every embed path (the deploy does the same with a 404.html copy),
 * and the sandbox documents at /sandbox/, so the Lite tier works on the dev and preview servers.
 * The documents go out without their sandbox header here; their own `<meta>` policy still
 * limits what they can fetch, and the embed frames them with `sandbox="allow-scripts"`.
 */
function embedServer(): Plugin {
  const handle: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
    const url = req.url ?? ''
    const document = SANDBOX_DOCUMENT.exec(url)
    if (document) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(`${SANDBOX_DIR}${document[1]}.html`))
      return
    }
    if (EMBED_ROUTE.test(url)) req.url = '/embed/'
    next()
  }
  return {
    name: 'fxm-embed-server',
    configureServer(server) {
      server.middlewares.use(handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle)
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
