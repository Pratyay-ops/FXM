// make dist builds the landing page with this config: apps/site/astro.config.ts plus hidden
// source maps and the bundle inventory, which list the npm packages in the site's scripts,
// stylesheets and assets for the licence check, and no .env files (src/dist-configs.ts). The
// source maps are never deployed. Everything else, the build check included, is the site's own
// config.
import site from '../../apps/site/astro.config.ts'
import { distSiteConfig } from './src/dist-configs.ts'

export default distSiteConfig(site)
