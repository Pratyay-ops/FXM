/**
 * The isolated evaluator (stage 1.11): where FXM runs code it must not run in its own pages,
 * namely YouTube's player script (to decipher stream URLs) and Google's BotGuard (to mint web PO
 * tokens), with one interface on every platform. See `README.md` in this folder.
 *
 * Only the host's side is exported here. The document's side (`runtime.ts`, `document.ts`) is
 * built into `apps/web/sandbox/eval.html` by `build.ts`.
 *
 * @module
 */

export {
  CAPACITOR_EVALUATOR_ORIGIN,
  CAPACITOR_EVALUATOR_PLUGIN,
  type CapacitorEvaluatorOptions,
  type CapacitorEvaluatorPlugin,
  createCapacitorEvaluator,
} from './capacitor'
export {
  type BotGuardChallenge,
  type CreateEvaluatorOptions,
  createEvaluator,
  EVALUATOR_OPEN_TIMEOUT_MS,
  EVALUATOR_TIMEOUT_MS,
  type EvaluateOptions,
  type Evaluator,
  type EvaluatorCallOptions,
  EvaluatorError,
  type EvaluatorFailure,
  type EvaluatorInfo,
  type EvaluatorKind,
  type EvaluatorOrigin,
  type EvaluatorPort,
  isEvaluatorError,
} from './evaluator'
export {
  createMailboxPort,
  HELLO_SCRIPT,
  type MailboxPortOptions,
  receiveScript,
  type ScriptRunner,
  takeScript,
} from './mailbox'
export { trustedParentOrigin } from './messages'
export {
  EVALUATOR_CHANNEL,
  EVALUATOR_ERROR_CODES,
  EVALUATOR_METHODS,
  EVALUATOR_NONCE,
  EVALUATOR_PROTOCOL_VERSION,
  type EvaluatorErrorCode,
  type EvaluatorHello,
  type EvaluatorMethod,
  type EvaluatorRequest,
  type EvaluatorResponse,
  parseEvaluatorHello,
  parseEvaluatorRequest,
  parseEvaluatorResponse,
} from './protocol'
export {
  createTauriEvaluator,
  TAURI_EVALUATOR_ORIGIN,
  TAURI_EVALUATOR_PLUGIN,
  type TauriEvaluatorOptions,
  type TauriInvoke,
} from './tauri'
export {
  createSandboxEvaluator,
  createSandboxPort,
  EVALUATOR_DOCUMENT_PATH,
  type EvaluatorHostWindow,
  type SandboxEvaluatorOptions,
} from './web'
