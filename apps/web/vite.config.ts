import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { ffmpegCoreDevPlugin } from '../../tools/ffmpeg-wasm/dev-server.ts'
import { APP_BASE } from './pwa/base.ts'
import { APP_HEADERS, headersRevision } from './pwa/host.ts'
import { pwaOptions } from './pwa/options.ts'
import { serviceWorkerSourceMap } from './pwa/source-map.ts'
import { distributionFlag } from './src/features/app-update/distribution-flag.ts'

export default defineConfig({
  // Production serves the player from /app/ (the landing page owns /). The router
  // reads its basename from import.meta.env.BASE_URL, so this is the only place to change.
  base: APP_BASE,
  // FXM_DISTRIBUTION=standard marks the Android app from GitHub Releases (release-apk.sh build),
  // the only build that checks for new app versions by itself, and fdroid an F-Droid build (stage
  // R.3), which never does (features/app-update). Any other value than those two fails here.
  define: {
    'import.meta.env.FXM_DISTRIBUTION': JSON.stringify(
      distributionFlag(process.env.FXM_DISTRIBUTION),
    ),
  },
  // The installable web app: manifest, icons and the service worker (see pwa/ and the README).
  // The host's header rule is part of the page's revision in the service worker (pwa/host.ts),
  // and make dist reads the service worker's source map like the app's (pwa/source-map.ts).
  plugins: [
    react(),
    tailwindcss(),
    VitePWA(pwaOptions(APP_BASE, { headersRevision: headersRevision(APP_HEADERS) })),
    serviceWorkerSourceMap(),
    // The locally built ffmpeg core at ffmpeg/ on the dev and preview servers (stage 4.2);
    // make dist puts the deployed one there.
    ffmpegCoreDevPlugin(),
  ],
})
