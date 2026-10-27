/**
 * `@fxm/downloads`: the download manager (stage 4.1). Runtime-agnostic: it fetches with the
 * platform's injected `fetch`, stores bytes through a `DownloadStorage` and records through a
 * `DownloadStore` that each platform implements, and plays downloads offline through the stream
 * lifecycle's `OfflineStore`. See `README.md`.
 *
 * @module
 */

export {
  type DownloadAvailability,
  downloadAvailability,
  downloadLane,
  isDownloadableStream,
} from './availability'
export type { Listener } from './emitter'
export { MAX_DOWNLOAD_BYTES, maxDownloadBytes, peakKbps } from './limits'
export {
  ALWAYS_ONLINE,
  DOWNLOAD_DEFAULTS,
  DOWNLOAD_WAITS,
  type DownloadEventMap,
  DownloadManager,
  type DownloadManagerOptions,
  type DownloadNetwork,
  type EnqueueAllResult,
  randomFileName,
} from './manager'
export {
  createOfflineStore,
  type OfflineStoreOptions,
  offlineIds,
  offlineStream,
} from './offline'
export {
  classifyDownloadFailure,
  type DownloadFailure,
  type DownloadFailureFacts,
  type DownloadFailureKind,
} from './recovery'
export {
  createPolicyDownloadResolver,
  type DownloadResolveReason,
  type DownloadResolveRequest,
  type DownloadResolver,
  NoDownloadableStreamError,
  type PolicyDownloadResolverOptions,
  type ResolvedDownload,
  UnreadableStreamError,
  unreadableStream,
} from './resolver'
export {
  assertSafeFileName,
  createMemoryDownloadStorage,
  type DownloadStorage,
  type DownloadWriter,
  isSafeFileName,
  isStorageFullError,
  isStorageUnavailableError,
  type MemoryDownloadStorage,
  type MemoryDownloadStorageOptions,
  storageFullError,
  storageUnavailableError,
} from './storage'
export {
  createMemoryDownloadStore,
  type DownloadRow,
  type DownloadStore,
  fileOfRow,
  type MemoryDownloadStore,
  type RecordChange,
} from './store'
export {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_WRITE_BYTES,
  DownloadHttpError,
  DownloadNetworkError,
  type DownloadNetworkPhase,
  DownloadProtocolError,
  type DownloadProtocolProblem,
  parseContentRange,
  parseRetryAfter,
  type TransferFacts,
  type TransferOptions,
  type TransferResult,
  transfer,
} from './transfer'
export {
  DOWNLOAD_ERROR_CODES,
  DOWNLOAD_STATUSES,
  type DownloadError,
  type DownloadErrorCode,
  type DownloadFileFormat,
  type DownloadRecord,
  type DownloadStatus,
  downloadId,
  fileFormatOf,
  isDownloadFileFormat,
  isDownloadRecord,
  isPendingDownload,
  newDownloadRecord,
  sameFileFormat,
  withoutError,
  withoutProgress,
} from './types'
