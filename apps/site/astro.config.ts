import sitemap from '@astrojs/sitemap'
import { defineConfig } from 'astro/config'
import { EXTERNAL_PATHS, SITE_URL } from './src/config'
import { buildCheck } from './src/integrations/build-check'

export default defineConfig({
  site: SITE_URL,
  // Pages build to files (dist/privacy.html), which Cloudflare Pages serves at /privacy.
  trailingSlash: 'never',
  build: { format: 'file' },
  // HTML whitespace rules: a line break between an inline element and text renders as a
  // space, as the Biome formatter assumes. Astro 7's default ('jsx') would drop it.
  compressHTML: true,
  // The build check must come after the sitemap, which it verifies.
  integrations: [sitemap(), buildCheck({ externalPaths: EXTERNAL_PATHS })],
  devToolbar: { enabled: false },
  vite: {
    // Fail instead of silently moving to the next port when the chosen one is taken.
    server: { strictPort: true },
    preview: { strictPort: true },
  },
})
