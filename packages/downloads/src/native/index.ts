/**
 * Downloads in the Android app (stage 6.4): the `DownloadStorage` in the app's own storage, the
 * foreground service that keeps downloads going in the background, and saving a download to
 * Music/FXM, all through the `FxmDownloads` plugin. See `README.md` in this folder.
 *
 * @module
 */

export { type BackgroundDownloadsOptions, connectBackgroundDownloads } from './background'
export { canExportToMusic, type ExportedDownload, exportDownloadToMusic } from './export'
export {
  FXM_DOWNLOADS_ERROR_CODES,
  FXM_DOWNLOADS_MAX_READ_BYTES,
  FXM_DOWNLOADS_PLUGIN,
  type FxmDownloadsErrorCode,
  type FxmDownloadsExport,
  type FxmDownloadsPlugin,
  type FxmDownloadsQueueReport,
  type FxmPermissionState,
  findFxmDownloadsPlugin,
  fxmDownloadsErrorCode,
} from './plugin'
export {
  createNativeDownloadStorage,
  type NativeDownloadStorage,
  type NativeDownloadStorageOptions,
  nativeStorageError,
} from './storage'
