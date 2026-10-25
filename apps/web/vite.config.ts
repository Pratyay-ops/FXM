import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { APP_BASE } from './pwa/manifest.ts'
import { pwaOptions } from './pwa/options.ts'

export default defineConfig({
  // Production serves the player from /app/ (the landing page owns /). The router
  // reads its basename from import.meta.env.BASE_URL, so this is the only place to change.
  base: APP_BASE,
  // The installable web app: manifest, icons and the service worker (see pwa/ and the README).
  plugins: [react(), tailwindcss(), VitePWA(pwaOptions())],
})
