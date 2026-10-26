import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { APP_BASE } from './pwa/base.ts'
import { APP_HEADERS, headersRevision } from './pwa/host.ts'
import { pwaOptions } from './pwa/options.ts'
import { serviceWorkerSourceMap } from './pwa/source-map.ts'

export default defineConfig({
  // Production serves the player from /app/ (the landing page owns /). The router
  // reads its basename from import.meta.env.BASE_URL, so this is the only place to change.
  base: APP_BASE,
  // The installable web app: manifest, icons and the service worker (see pwa/ and the README).
  // The host's header rule is part of the page's revision in the service worker (pwa/host.ts),
  // and make dist reads the service worker's source map like the app's (pwa/source-map.ts).
  plugins: [
    react(),
    tailwindcss(),
    VitePWA(pwaOptions(APP_BASE, { headersRevision: headersRevision(APP_HEADERS) })),
    serviceWorkerSourceMap(),
  ],
})
