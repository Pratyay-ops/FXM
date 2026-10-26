// make dist builds the web app with this config: apps/web/vite.config.ts plus the bundle
// inventory in the app's build and its workers', the workers' source maps for the licence check,
// and no .env files (src/dist-configs.ts). Everything else, the base /app/ included, is the app's
// own config; make dist adds hidden source maps on the command line.
import web from '../../apps/web/vite.config.ts'
import { distAppConfig } from './src/dist-configs.ts'

if (typeof web !== 'object' || web === null) {
  throw new Error('apps/web/vite.config.ts no longer exports an object: update app.vite.config.ts')
}

export default distAppConfig(web)
