/** Where make dist reads and writes. */
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, as a real path: the builds write source maps relative to it. */
export const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))

/** The folder make dist writes and the deploy job uploads to Cloudflare Pages. */
export const PAGES_DIR = join(ROOT, 'dist', 'pages')

/**
 * The bundle inventories of the last make dist, one `<part>.jsonl` each: never deployed, read by
 * the web app's performance budgets (apps/web/e2e/budgets).
 */
export const INVENTORY_DIR = join(ROOT, 'dist', 'inventory')

/** Scratch space for one make dist run. */
export const STAGING_DIR = join(ROOT, 'dist', '.staging')

export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

/** True when the module was started with `node <file>` rather than imported. */
export function isMain(meta: ImportMeta): boolean {
  // import.meta.main exists from Node 22.18; the engines field allows 22.13.
  const main = (meta as { main?: boolean }).main
  if (main !== undefined) return main
  const script = process.argv[1]
  return script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(meta.url))
}
