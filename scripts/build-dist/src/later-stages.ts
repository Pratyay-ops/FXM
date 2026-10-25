/**
 * Touch-points with stages that hadn't merged when stage 2.8 started (an early start, owner
 * decision of 2026-10-26). Each is a Part with a fake in testing.ts. When a stage merges, its
 * integration changes only the part's build() here; the composition, the `_headers` rules
 * and the checks already handle the output.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Part } from './parts.ts'

/**
 * 5.2, the embeddable mini-player at `/embed/`: a single-page app built for base `/embed/`,
 * with the app's policy minus `frame-ancestors`. 5.2 hasn't specified its build yet, so this
 * part doesn't exist. To wire it in, build the embed into outDir the way appPart builds the
 * app: hidden source maps, and the bundle inventory plugin (src/bundle-inventory.ts) with
 * `{ [INVENTORY_VARIABLE]: inventoryFile }` in the build's environment. Then return true.
 */
export const embedPart: Part = {
  name: 'embed',
  mount: 'embed',
  required: false,
  spa: true,
  sourceMaps: true,
  build() {
    return false
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
 *   before that script, so a copy served without FXM's headers keeps its hosts and its hash;
 * - no inline code that looks bundled (a licence banner, or more than 64 KiB), because this
 *   part has no source maps for the licence check. A document that bundles npm packages must
 *   be built here instead, with source maps.
 *
 * And one rule the build can't check: the script must do nothing unless `self.origin` is
 * `'null'` (not `location.origin`, which a sandboxed document still reports as FXM's). Served
 * from FXM, every path that reaches a document carries `sandbox` (its own rules, or the
 * encoded-path rules in rules.ts); the check keeps a document inert wherever it isn't.
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
