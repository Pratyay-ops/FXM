/**
 * The script of `apps/web/sandbox/eval.html`: it starts the evaluator in that document. `build.ts`
 * bundles it, with bgutils-js, into the document's one inline script.
 *
 * @module
 */

import { startEvaluatorDocument } from './document'

startEvaluatorDocument(window)
