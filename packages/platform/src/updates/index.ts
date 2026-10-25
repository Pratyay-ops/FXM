/**
 * Signed updates for the desktop and Android apps (stage 1.13): the YouTube config and resolver
 * module, fetched from FXM's static site, verified against a public key compiled into the
 * build, and loaded only when newer than what the app has. See `README.md` in this folder.
 *
 * Only what the apps use is exported here. Signing (`sign.ts`) and the format's encoders are
 * for the owner's scripts and tests, which import those files directly; the test helpers are in
 * `@fxm/platform/testing`.
 *
 * @module
 */

export {
  type ActivationInfo,
  type CodeArtifactSpec,
  codeArtifact,
  type FailureListener,
  type JsonArtifactSpec,
  jsonArtifact,
  type UpdateArtifact,
  type UpdateOrigin,
  type VersionInUse,
} from './artifact.ts'
export {
  DEFAULT_CODE_MAX_BYTES,
  DEFAULT_JSON_MAX_BYTES,
  MAX_VERSION,
  type UpdateStatement,
} from './format.ts'
export {
  type RevokedVersions,
  type TrustedKeys,
  UPDATE_SIGNING_KEYS,
  UPDATE_SIGNING_READY,
} from './keys.ts'
export { canImportModules, type ModuleImporter, type ModuleImportOptions } from './loader.ts'
export {
  CODE_UPDATES_CONSENT,
  DISTRIBUTIONS,
  type Distribution,
  parseDistribution,
  type UpdatePolicy,
  updatePolicy,
} from './policy.ts'
export {
  type IndexedDbUpdateStoreOptions,
  indexedDbUpdateStore,
  memoryUpdateStore,
  type StoredUpdate,
  type UpdateStore,
} from './store.ts'
export {
  type ArtifactOutcome,
  type ArtifactReport,
  type ArtifactStatus,
  createUpdater,
  DEFAULT_UPDATE_BASE_URLS,
  type UpdateCheckOptions,
  type UpdateFetch,
  type UpdateProblem,
  type UpdateProblemReason,
  type UpdateReport,
  type UpdateRequestInit,
  type Updater,
  type UpdaterOptions,
  updateFetchFromNative,
} from './updater.ts'
export {
  createSignatureVerifier,
  type SignatureVerifier,
  type TrustedKey,
  type VerificationFailure,
  type VerifierEngine,
  type VerifierOptions,
} from './verify.ts'
