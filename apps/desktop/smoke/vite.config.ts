import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Builds the smoke test's page into smoke/dist, which tauri.smoke.conf.json embeds instead of the
// web app. Base `/`, as the app serves it from tauri://localhost.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
