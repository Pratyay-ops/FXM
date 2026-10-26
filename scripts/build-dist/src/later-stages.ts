/**
 * Touch-points with stages that hadn't merged when stage 2.8 started (an early start, owner
 * decision of 2026-10-26). Each is a Part with a fake in testing.ts. When a stage merges, its
 * integration changes only the part's build() here; the composition, the `_headers` rules
 * and the checks already handle the output.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { INVENTORY_VARIABLE } from './bundle-inventory.ts'
import type { Part } from './parts.ts'

/**
 * 5.2, the embeddable mini-player at `/embed/`: a single-page app built for base `/embed/`
 * (apps/web/vite.embed.config.ts), with its own policy (`appPolicy({ embeddable: true })`: no
 * `frame-ancestors`, no worker, only the hosts of the services it plays from), and the headers
 * every response gets, `Cross-Origin-Opener-Policy: same-origin` among them (COMMON_HEADERS in
 * policies.ts). Its player addresses answer 200 through `_redirects` (redirects.ts). Built the way appPart builds the app: hidden source maps, the
 * bundle inventory and no `.env` files (embed.vite.config.ts, src/dist-configs.ts).
 */
export const embedPart: Part = {
  name: 'embed',
  mount: 'embed',
  required: false,
  spa: true,
  sourceMaps: true,
  build(outDir, { root, run, inventoryFile }) {
    if (!existsSync(join(root, 'apps/web/vite.embed.config.ts'))) return false
    run(
      'pnpm',
      [
        '--filter',
        '@fxm/web',
        'exec',
        'vite',
        'build',
        '--config',
        join(root, 'scripts/build-dist/embed.vite.config.ts'),
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

/**
 * 1.10 and 1.11, the sandbox documents at `/sandbox/`: `innertube.html` and `userhost.html`
 * (1.10) and `eval.html` (1.11). Their source folder is fixed by their scope in docs/PLAN.md;
 * copied as they are, they are present as soon as those stages merge. `make dist` holds each
 * document to this contract:
 *
 * - one inline script, which its policy allows by hash, and no other script;
 * - the same policy without `sandbox` in a `<meta http-equiv="Content-Security-Policy">`
 *   before that script, so wherever the document is served without its headers, it keeps
 *   its hosts and its hash;
 * - a script that does nothing unless `self.origin === 'null'` (not `location.origin`, which a
 *   sandboxed document still reports as FXM's). Pages also serves each document at its path
 *   with a letter percent-encoded, such as `/sandbox/innertub%65`, where no `_headers` rule
 *   and so no `sandbox` applies (headers-file.ts). make dist only checks that the test is
 *   there; the browser checks confirm on each deployment that the document stays inert;
 * - no inline code that looks bundled (a licence banner, or more than 64 KiB), because this
 *   part has no source maps for the licence check. A document that bundles npm packages, such
 *   as 1.11's `eval.html` with bgutils-js, keeps its script unminified with the bundler's
 *   `//#region <path>` markers, from which make dist attributes those packages (licenses.ts).
 */
export const sandboxPart: Part = {
  name: 'sandbox',
  mount: 'sandbox',
  required: false,
  spa: false,
  sourceMaps: false,
  build(outDir, { root }) {
    const source = join(root, 'apps/web/sandbox')
    if (!existsSync(source)) return false
    const documents = readdirSync(source).filter((name) => name.endsWith('.html'))
    for (const name of documents) copyFileSync(join(source, name), join(outDir, name))
    return documents.length > 0
  },
}
