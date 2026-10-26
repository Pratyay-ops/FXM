/**
 * `@fxm/plugins/testing`: the tiny local test plugin, a fake catalog for it, an in-memory store,
 * sandboxes that run plugins in this process, and a provider context, for this package's tests
 * and the apps'. Never import this from app code.
 *
 * @module
 */

import { createInProcessEvaluator, type InProcessEvaluator } from '@fxm/platform/testing'
import { IN_PROCESS_FOR_TESTS, isolatedSandboxes, type PluginSandboxes } from '../sandboxes'
import { installTestWorker } from './test-worker'

export { memoryPluginStore } from '../registry'
export { testContext } from './context'
export * from './test-plugin'
export { installTestWorker, TestWorker } from './test-worker'

/**
 * Sandboxes for tests: a document per plugin, each an in-process evaluator (the real runtime of
 * `eval.html`, run in this realm), whose relay starts the plugin's worker as a {@link TestWorker}
 * in a fresh realm. `onCreate` sees each evaluator, e.g. to count documents or read the requests
 * they got. Isolates nothing: for tests only.
 */
export function inProcessSandboxes(
  onCreate: (evaluator: InProcessEvaluator) => void = () => {},
): PluginSandboxes {
  installTestWorker()
  return isolatedSandboxes(
    () => {
      const evaluator = createInProcessEvaluator()
      onCreate(evaluator)
      return evaluator
    },
    { [IN_PROCESS_FOR_TESTS]: true },
  )
}
