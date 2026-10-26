/**
 * The configs `make dist` builds the site, the web app and the embeddable player with
 * (site.astro.config.mjs, app.vite.config.ts and embed.vite.config.ts): each one's own config,
 * plus what the checks need. They are here, apart from the config files, so that the tests can
 * check them without loading any one's plugins.
 *
 * No build reads `.env` files (`envDir: false`): their build variables, such as
 * `VITE_FXM_JAMENDO_CLIENT_ID` (README.md, "Jamendo"), come from make dist's environment alone,
 * which is also where the policies (`offeredServices`) read them. Otherwise a developer's
 * `apps/web/.env.local`, kept for `make dev`, could make the app offer Jamendo while the `/app/*`
 * policy blocks it and the site calls it coming soon, or put the development fakes in the build.
 */
import { bundleInventory } from './bundle-inventory.ts'
import { workerSourceMaps } from './worker-source-maps.ts'

/** The parts of a Vite config that make dist extends. */
export interface ViteConfigLike {
  readonly plugins?: readonly unknown[] | undefined
  readonly worker?: { readonly plugins?: (() => readonly unknown[]) | undefined } | undefined
  readonly build?: object | undefined
}

/**
 * The web app's config for make dist, and the embeddable player's (stage 5.2): apps/web's
 * vite.config.ts, or vite.embed.config.ts, with
 *
 * - the bundle inventory (src/bundle-inventory.ts) in the app's build and in each worker's,
 *   whose entries say `worker`: the licence check reads every chunk's modules from it, the
 *   workers' included, so LGPL code can't hide in a worker next to other code;
 * - source maps of the workers that name their sources where the licence check finds them
 *   (src/worker-source-maps.ts);
 * - no `.env` files. make dist adds hidden source maps on the command line.
 */
export function distAppConfig<T extends ViteConfigLike>(web: T) {
  const workerPlugins = web.worker?.plugins
  return {
    ...web,
    envDir: false as const,
    plugins: [...(web.plugins ?? []), bundleInventory(), workerSourceMaps()],
    worker: {
      ...web.worker,
      plugins: () => [...(workerPlugins?.() ?? []), bundleInventory({ environment: 'worker' })],
    },
  }
}

/** The parts of an Astro config that make dist extends. */
export interface AstroConfigLike {
  readonly vite?: ViteConfigLike | undefined
}

/**
 * The landing page's config for make dist: apps/site/astro.config.ts with the bundle inventory,
 * hidden source maps, which are never deployed, and no `.env` files (Astro, too, would otherwise
 * read them into the environment its pages are rendered in, where `AVAILABLE.jamendo` reads).
 */
export function distSiteConfig<T extends AstroConfigLike>(site: T) {
  return {
    ...site,
    vite: {
      ...site.vite,
      envDir: false as const,
      plugins: [...(site.vite?.plugins ?? []), bundleInventory()],
      build: { ...site.vite?.build, sourcemap: 'hidden' as const },
    },
  }
}
