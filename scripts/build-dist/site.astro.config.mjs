// make dist builds the landing page with this config: apps/site/astro.config.ts plus hidden
// source maps and the bundle inventory, which list the npm packages in the site's scripts,
// stylesheets and assets for the licence check (src/bundle-inventory.ts). The source maps are
// never deployed. Everything else, the build check included, is the site's own config.
import site from '../../apps/site/astro.config.ts'
import { bundleInventory } from './src/bundle-inventory.ts'

export default {
  ...site,
  vite: {
    ...site.vite,
    plugins: [...(site.vite?.plugins ?? []), bundleInventory()],
    build: { ...site.vite?.build, sourcemap: 'hidden' },
  },
}
