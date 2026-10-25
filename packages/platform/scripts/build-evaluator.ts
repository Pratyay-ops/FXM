/**
 * Writes the evaluator document, apps/web/sandbox/eval.html, and prints the policy to serve it
 * with. Run it with `scripts/run.sh pnpm --filter @fxm/platform build:evaluator`.
 */
import { writeFileSync } from 'node:fs'
import { buildEvaluatorDocument, EVALUATOR_DOCUMENT_FILE } from '../src/evaluator/build.ts'

const document = await buildEvaluatorDocument()
const target = new URL(`../../../${EVALUATOR_DOCUMENT_FILE}`, import.meta.url)
writeFileSync(target, document.html)
console.log(`Wrote ${EVALUATOR_DOCUMENT_FILE} (${document.html.length} characters).`)
console.log(`Serve it with: Content-Security-Policy: ${document.headerPolicy}`)
