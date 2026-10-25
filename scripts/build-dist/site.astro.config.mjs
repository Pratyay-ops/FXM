// make dist builds the landing page with this config: apps/site/astro.config.ts plus hidden
// source maps, which list the npm packages in the site's scripts for the licence check. They
// are never deployed. Everything else, the build check included, is the site's own config.
import site from '../../apps/site/astro.config.ts'

export default {
  ...site,
  vite: { ...site.vite, build: { ...site.vite?.build, sourcemap: 'hidden' } },
}
