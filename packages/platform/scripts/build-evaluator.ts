/**
 * Writes the evaluator document, apps/web/sandbox/eval.html, and the Android plugin's pin of it,
 * and prints the policy to serve it with. Run it with
 * `scripts/run.sh pnpm --filter @fxm/platform build:evaluator`.
 */
import { writeFileSync } from 'node:fs'
import {
  buildEvaluatorDocument,
  documentSha256,
  EVALUATOR_ANDROID_PIN_FILE,
  EVALUATOR_DOCUMENT_FILE,
  renderAndroidPin,
} from '../src/evaluator/build.ts'

const document = await buildEvaluatorDocument()
const root = new URL('../../../', import.meta.url)
writeFileSync(new URL(EVALUATOR_DOCUMENT_FILE, root), document.html)
console.log(`Wrote ${EVALUATOR_DOCUMENT_FILE} (${document.html.length} characters).`)
const sha256 = await documentSha256(document.html)
writeFileSync(new URL(EVALUATOR_ANDROID_PIN_FILE, root), renderAndroidPin(sha256))
console.log(`Wrote ${EVALUATOR_ANDROID_PIN_FILE} (SHA-256 ${sha256}).`)
console.log(`Serve it with: Content-Security-Policy: ${document.headerPolicy}`)
