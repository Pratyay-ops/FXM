/**
 * The pieces `make dist` composes into one folder for Cloudflare Pages (docs/PLAN.md, 2.8):
 * the landing page at `/`, the web app at `/app/`, the embed at `/embed/` and the sandbox
 * documents at `/sandbox/`. The site and the app are built here; the embed and the sandbox
 * documents come from other stages, through the adapters in later-stages.ts.
 */
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { INVENTORY_VARIABLE } from './bundle-inventory.ts'
import { embedPart, sandboxPart } from './later-stages.ts'

export interface BuildContext {
  /** The repository root. */
  readonly root: string
  /**
   * Where a build appends its bundle inventory (src/bundle-inventory.ts): pass it to the build
   * as `{ [INVENTORY_VARIABLE]: inventoryFile }`. Outside the part's folder, never deployed.
   */
  readonly inventoryFile: string
  /** Runs a command in the repository root, with extra environment variables; throws when it fails. */
  run(command: string, args: readonly string[], env?: Readonly<Record<string, string>>): void
  log(message: string): void
}

export interface Part {
  /** Shown in the log and in the notices' "Used in" lines. */
  readonly name: string
  /** The folder the part is served from: '' for the root, otherwise one top-level folder. */
  readonly mount: '' | 'app' | 'embed' | 'sandbox'
  /** make dist fails without it. */
  readonly required: boolean
  /** A single-page app: its index.html is copied to 404.html, which Pages serves for its routes. */
  readonly spa: boolean
  /**
   * The build writes a source map next to every bundle (Vite's `--sourcemap hidden`). The licence
   * check reads them to list the npm packages inside, and they are never deployed. A part without
   * them may not ship JavaScript files, nor inline code that looks bundled (licenses.ts).
   */
  readonly sourceMaps: boolean
  /** Builds the part into outDir, an empty folder. Returns false when the part doesn't exist yet. */
  build(outDir: string, context: BuildContext): boolean
}

/**
 * The landing page (apps/site), built as `pnpm --filter @fxm/site build` does, with source maps
 * and the bundle inventory (site.astro.config.mjs).
 */
export const sitePart: Part = {
  name: 'site',
  mount: '',
  required: true,
  spa: false,
  sourceMaps: true,
  build(outDir, { root, run, inventoryFile }) {
    const site = join(root, 'apps/site')
    run(
      'pnpm',
      [
        '--filter',
        '@fxm/site',
        'exec',
        'astro',
        'build',
        '--root',
        site,
        // Astro joins --config to the root, so it must be relative.
        '--config',
        relative(site, join(root, 'scripts/build-dist/site.astro.config.mjs')),
        '--outDir',
        outDir,
      ],
      { [INVENTORY_VARIABLE]: inventoryFile },
    )
    return true
  },
}

/**
 * The web app (apps/web), with its production base /app/, source maps and the bundle
 * inventory (app.vite.config.ts).
 */
export const appPart: Part = {
  name: 'app',
  mount: 'app',
  required: true,
  spa: true,
  sourceMaps: true,
  build(outDir, { root, run, inventoryFile }) {
    run(
      'pnpm',
      [
        '--filter',
        '@fxm/web',
        'exec',
        'vite',
        'build',
        '--config',
        join(root, 'scripts/build-dist/app.vite.config.ts'),
        '--sourcemap',
        'hidden',
        '--outDir',
        outDir,
        '--emptyOutDir',
      ],
      { [INVENTORY_VARIABLE]: inventoryFile },
    )
    return true
  },
}

/** Everything make dist composes, in the order it builds them. */
export const PARTS: readonly Part[] = [sitePart, appPart, embedPart, sandboxPart]

/** Runs commands with the inherited terminal, the way make shows them. */
export function spawnRunner(root: string): BuildContext['run'] {
  return (command, args, env = {}) => {
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} failed with exit code ${result.status ?? result.signal}`,
      )
    }
  }
}
