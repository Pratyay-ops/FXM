// make dist builds the embeddable player with this config: apps/web/vite.embed.config.ts plus the
// bundle inventory, which lists the npm packages the embed takes stylesheets, fonts, images and
// WebAssembly from for the licence check (src/bundle-inventory.ts). Everything else, the base
// /embed/ included, is the embed's own config; make dist adds hidden source maps and the output
// folder on the command line.
import embed from '../../apps/web/vite.embed.config.ts'
import { bundleInventory } from './src/bundle-inventory.ts'

if (typeof embed !== 'object' || embed === null) {
  throw new Error(
    'apps/web/vite.embed.config.ts no longer exports an object: update embed.vite.config.ts',
  )
}

export default { ...embed, plugins: [...(embed.plugins ?? []), bundleInventory()] }
