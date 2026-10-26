/**
 * Where production serves the player; the landing page owns `/` (docs/ARCHITECTURE.md §1).
 * It is Vite's `base`, the service worker's scope and the installed app's identity. The
 * Android and desktop builds use base `/`, which leaves the installable web app out.
 *
 * This module imports nothing, so the app's own code can read it too
 * (src/features/pwa/web-app.ts).
 *
 * @module
 */

export const APP_BASE = '/app/'
