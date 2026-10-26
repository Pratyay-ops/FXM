import { fileURLToPath } from 'node:url'

// What the browser tests run against. playwright.config.ts builds apps/web and serves it with
// `vite preview`; flows/playwright.config.ts serves `make dist`'s dist/pages the way Cloudflare
// Pages does, with its real `_headers`, and sets FXM_E2E_TARGET=pages. With FXM_E2E_BASE_URL,
// playwright.config.ts tests a server that is up already, which is `make dist`'s folder served by
// the Pages stand-in (`scripts/run.sh pnpm --filter @fxm/deploy preview`) unless
// FXM_E2E_TARGET=preview says it is a `vite preview`. The specs read this, rather than guess from
// the URL.

/** `pages` for `make dist` served like Cloudflare Pages, `preview` for `vite preview`. */
export const TARGET: 'pages' | 'preview' = target(process.env)

/** The target the environment names: FXM_E2E_TARGET, else `pages` for a server that is up. */
export function target(env: Readonly<Record<string, string | undefined>>): 'pages' | 'preview' {
  if (env.FXM_E2E_TARGET === 'pages' || env.FXM_E2E_TARGET === 'preview') return env.FXM_E2E_TARGET
  if (env.FXM_E2E_TARGET !== undefined && env.FXM_E2E_TARGET !== '') {
    throw new Error(`FXM_E2E_TARGET is ${env.FXM_E2E_TARGET}: use pages or preview`)
  }
  return env.FXM_E2E_BASE_URL === undefined || env.FXM_E2E_BASE_URL === '' ? 'preview' : 'pages'
}

/** The repository root. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The folder `make dist` composes, or the one in FXM_PAGES_DIR. */
export const PAGES_DIR = process.env.FXM_PAGES_DIR ?? `${REPOSITORY_ROOT}dist/pages`

/**
 * The folder the app's files are served from: dist/pages/app for `make dist`, apps/web/dist for
 * `vite preview`. The PWA tests publish new versions of its `sw.js`.
 */
export const APP_DIR =
  TARGET === 'pages' ? `${PAGES_DIR}/app` : fileURLToPath(new URL('../dist', import.meta.url))

/**
 * Whether the server serves the sandbox documents itself, with the policies of the deploy's
 * `_headers` (`sandbox allow-scripts` and their hashes). `vite preview` doesn't, so the specs
 * serve the source document for it.
 */
export const SERVES_SANDBOX = TARGET === 'pages'
