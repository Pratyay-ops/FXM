/**
 * Writes the sandbox documents into `apps/web/sandbox/`. Run it after changing `document.ts`:
 *
 * ```sh
 * scripts/run.sh pnpm --filter @fxm/platform sandbox:build
 * ```
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxDocumentKind } from '../document.ts'
import { DOCUMENTS_DIR, renderSandboxDocument, SANDBOX_DOCUMENT_FILES } from './render.ts'

await mkdir(DOCUMENTS_DIR, { recursive: true })
for (const kind of Object.keys(SANDBOX_DOCUMENT_FILES) as SandboxDocumentKind[]) {
  const path = join(DOCUMENTS_DIR, SANDBOX_DOCUMENT_FILES[kind].file)
  await writeFile(path, await renderSandboxDocument(kind))
  console.log(`wrote ${path}`)
}
