/**
 * The web app's service worker and the deploy (stages 5.1 and 2.8). The worker answers every
 * navigation with its stored copy of app/index.html, and with the headers that copy came with,
 * the policy among them, and stores the page again only when the page's precache revision
 * changes. The app's build can't know the final page, to which make dist adds its policy's meta
 * elements, nor the `/app/*` rule make dist writes. So make dist sets that revision here from
 * both (apps/web/pwa/host.ts): a deploy that changes only the rule, such as a new service's
 * hosts or a new header, still ships a new worker, and installed apps get the new page and its
 * headers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pageRevision, setPageRevision } from '../../../apps/web/pwa/host.ts'
import type { HeaderRule } from './headers-file.ts'

/** The app's service worker, and the page it stores, in the composed folder. */
export const SERVICE_WORKER = 'app/sw.js'
export const APP_PAGE = 'app/index.html'

/**
 * Gives the page in the composed service worker the precache revision of the final page and
 * its `/app/*` rule, and returns that revision; undefined when the app has no service worker.
 * Throws when the worker doesn't hold the revision the build gave the page.
 */
export function revisePage(pagesDir: string, rules: readonly HeaderRule[]): string | undefined {
  const worker = join(pagesDir, SERVICE_WORKER)
  if (!existsSync(worker)) return undefined
  const rule = rules.find((candidate) => candidate.path === '/app/*')
  if (!rule) throw new Error(`${SERVICE_WORKER} exists, but no rule serves /app/*`)
  const page = readFileSync(join(pagesDir, APP_PAGE), 'utf8')
  const revision = pageRevision(page, Object.fromEntries(rule.headers))
  try {
    writeFileSync(worker, setPageRevision(readFileSync(worker, 'utf8'), revision))
  } catch (error) {
    throw new Error(`${SERVICE_WORKER}: ${(error as Error).message}`)
  }
  return revision
}
