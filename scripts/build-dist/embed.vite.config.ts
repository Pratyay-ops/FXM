// make dist builds the embeddable player with this config: apps/web/vite.embed.config.ts with
// what make dist gives the app (src/dist-configs.ts): the bundle inventory in its build and its
// workers', which lists the npm packages the embed takes stylesheets, fonts, images and
// WebAssembly from for the licence check, the workers' source maps, and no .env files.
// Everything else, the base /embed/ included, is the embed's own config; make dist adds hidden
// source maps and the output folder on the command line.
import embed from '../../apps/web/vite.embed.config.ts'
import { distAppConfig } from './src/dist-configs.ts'

if (typeof embed !== 'object' || embed === null) {
  throw new Error(
    'apps/web/vite.embed.config.ts no longer exports an object: update embed.vite.config.ts',
  )
}

export default distAppConfig(embed)
