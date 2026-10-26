/**
 * An evaluator for tests: the real runtime of `eval.html`, run in the test's own realm instead of
 * an isolated document. Requests and answers still go through JSON, as over a real channel.
 * It isolates nothing, so it is for tests and tooling only.
 *
 * @module
 */

import {
  type CreateEvaluatorOptions,
  createEvaluator,
  type Evaluator,
  type EvaluatorKind,
} from '../evaluator/evaluator'
import {
  EVALUATOR_CHANNEL,
  EVALUATOR_PROTOCOL_VERSION,
  type EvaluatorRequest,
} from '../evaluator/protocol'
import { createEvaluatorRuntime } from '../evaluator/runtime'

/** Options for {@link createInProcessEvaluator}. */
export interface InProcessEvaluatorOptions extends CreateEvaluatorOptions {
  /** The kind it reports. Default `in-process`. */
  kind?: EvaluatorKind
  /** The document origin it reports. Default `about:`. */
  origin?: string
}

/** An in-process evaluator that records what it was asked. */
export interface InProcessEvaluator extends Evaluator {
  /** Every request it received, in order. */
  readonly requests: readonly EvaluatorRequest[]
}

/** Creates an in-process evaluator. */
export function createInProcessEvaluator(
  options: InProcessEvaluatorOptions = {},
): InProcessEvaluator {
  const { kind = 'in-process', origin = 'about:', ...evaluatorOptions } = options
  const runtime = createEvaluatorRuntime()
  const requests: EvaluatorRequest[] = []
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
  const evaluator = createEvaluator(
    kind,
    {
      async open() {
        return {
          channel: EVALUATOR_CHANNEL,
          type: 'ready',
          version: EVALUATOR_PROTOCOL_VERSION,
          origin,
        }
      },
      async send(request) {
        requests.push(request)
        return roundTrip(await runtime.handle(roundTrip(request)))
      },
      close() {},
    },
    { ...evaluatorOptions, origin },
  )
  return Object.assign(evaluator, {
    get requests() {
      return requests
    },
  })
}
