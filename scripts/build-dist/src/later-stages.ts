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
 * part doesn't exist. To wire it in, build the embed into outDir with hidden source maps
 * (`vite build --sourcemap hidden --outDir <outDir>`, as appPart does) and return true.
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
 * (1.10) and `eval.html` (1.11), each a self-contained page whose script is inline, so its
 * policy can allow it by hash. Their source folder is fixed by their scope in docs/PLAN.md;
 * copied as they are, they are present as soon as those stages merge.
 *
 * If a stage generates these documents from code that bundles npm packages, build them here
 * instead and set sourceMaps, so the licence check sees what they contain.
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
