// make dist builds the web app with this config: apps/web/vite.config.ts plus the bundle
// inventory, which lists the npm packages the app takes stylesheets, fonts, images and
// WebAssembly from for the licence check (src/bundle-inventory.ts). Everything else, the base
// /app/ included, is the app's own config; make dist adds hidden source maps on the command line.
import web from '../../apps/web/vite.config.ts'
import { bundleInventory } from './src/bundle-inventory.ts'

if (typeof web !== 'object' || web === null) {
  throw new Error('apps/web/vite.config.ts no longer exports an object: update app.vite.config.ts')
}

export default { ...web, plugins: [...(web.plugins ?? []), bundleInventory()] }
