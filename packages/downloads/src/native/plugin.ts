/**
 * The `FxmDownloads` Capacitor plugin: the Android app's side of downloads (stage 6.4). Its native
 * side is `apps/mobile/android/fxm-downloads` (`FxmDownloadsPlugin.kt`), which documents the same
 * messages: the files of downloads in the app's own storage, saving a copy to Music/FXM, and the
 * foreground service that keeps downloads going in the background. The wire types carry the
 * `FxmDownloads` prefix, like `FxmHttp` in `@fxm/platform` and `FxmPlayer` in `@fxm/player`.
 *
 * @module
 */

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmDownloads`). */
export const FXM_DOWNLOADS_PLUGIN = 'FxmDownloads'

/** The most bytes one `read` returns: 1 MiB. */
export const FXM_DOWNLOADS_MAX_READ_BYTES = 1024 * 1024

/**
 * Every code the plugin rejects with (the `code` of the bridge's error):
 *
 * - `BAD_REQUEST`: a malformed message, e.g. a file name the manager would never give, or a
 *   format that can't be saved to Music (a video file)
 * - `NOT_FOUND`: no such file, or no file open under that handle
 * - `BUSY`: the file is open for writing already, or still being written
 * - `NO_SPACE`: the disk is full, or a write would leave less free than Android's own
 *   low-storage reserve (5 % of the storage, at most 500 MiB)
 * - `DENIED`: the user refused a permission it needs (saving to Music on Android 9 and older)
 * - `UNAVAILABLE`: the app's storage can't be used at all
 * - `IO`: any other failure of the storage
 */
export const FXM_DOWNLOADS_ERROR_CODES = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'BUSY',
  'NO_SPACE',
  'DENIED',
  'UNAVAILABLE',
  'IO',
] as const

/** One of {@link FXM_DOWNLOADS_ERROR_CODES}. */
export type FxmDownloadsErrorCode = (typeof FXM_DOWNLOADS_ERROR_CODES)[number]

/** The bridge error's `code`, when it is one of {@link FXM_DOWNLOADS_ERROR_CODES}. */
export function fxmDownloadsErrorCode(error: unknown): FxmDownloadsErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return (FXM_DOWNLOADS_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as FxmDownloadsErrorCode)
    : undefined
}

/**
 * A Capacitor permission state: `granted`, `denied` (the user refused for good, so only
 * Android's settings can allow it), or `prompt`/`prompt-with-rationale` (Android asks next time).
 */
export type FxmPermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

/** What the web app's download queue reports, for the foreground service. */
export interface FxmDownloadsQueueReport {
  /** Downloads being fetched now. */
  readonly downloading: number
  /** Downloads waiting their turn. */
  readonly queued: number
  /** Whether the device is online: the service keeps the device awake only then. */
  readonly online: boolean
  /** The title of a song being downloaded, for the notification. */
  readonly title?: string
}

/** What saving a download to Music/FXM needs. */
export interface FxmDownloadsExport {
  /** The download's file. */
  readonly file: string
  /** Its format (`DownloadFileFormat`), which decides the file's name and type there. */
  readonly codec: string
  readonly container: string
  readonly media: string
  /** The song's title and artists, for the file's name, and its album. */
  readonly title: string
  readonly artists: readonly string[]
  readonly album?: string
}

/**
 * The `FxmDownloads` plugin as the Capacitor bridge exposes it. Every method rejects with an
 * error whose `code` is one of {@link FXM_DOWNLOADS_ERROR_CODES} ({@link fxmDownloadsErrorCode}).
 * File names are the download manager's own (`isSafeFileName`); bytes travel in base64.
 */
export interface FxmDownloadsPlugin {
  /** Whether downloads can be stored, the bytes they may still take, and the reserve left free. */
  info(): Promise<{ available: boolean; freeBytes: number; reserveBytes: number }>
  /** Opens `file` for writing, creating it empty: its handle and size. One writer per file. */
  open(options: { readonly file: string }): Promise<{ handle: string; size: number }>
  /** Writes base64 `data` at `offset`; resolves with the file's size. */
  write(options: {
    readonly handle: string
    readonly offset: number
    readonly data: string
  }): Promise<{ size: number }>
  /** Cuts or extends the file to `size` bytes. */
  truncate(options: { readonly handle: string; readonly size: number }): Promise<{ size: number }>
  /** Makes what was written survive a crash. */
  flush(options: { readonly handle: string }): Promise<void>
  /** The open file's size. */
  size(options: { readonly handle: string }): Promise<{ size: number }>
  /** Flushes and releases the file; an unknown handle is ignored. */
  close(options: { readonly handle: string }): Promise<void>
  /** `file`'s size and `file:` URI, both `null` when it doesn't exist. */
  stat(options: { readonly file: string }): Promise<{ size: number | null; uri: string | null }>
  /** Up to `length` bytes (at most 1 MiB) from `offset`, base64; `null` when the file is gone. */
  read(options: {
    readonly file: string
    readonly offset: number
    readonly length: number
  }): Promise<{ data: string | null; size: number | null }>
  /** Deletes `file`; a file that doesn't exist is fine, an open one is `BUSY`. */
  remove(options: { readonly file: string }): Promise<void>
  /** The names of every stored file. */
  list(): Promise<{ files: string[] }>
  /**
   * Saves a copy of a complete download to Music/FXM (asking for the permission it needs on
   * Android 9 and older): its MediaStore `uri` and its `path` there. Saved before with the same
   * name and size, it is not saved again.
   */
  exportToMusic(options: FxmDownloadsExport): Promise<{ uri: string; path: string }>
  /**
   * Reports the download queue: the foreground service runs while it has work. Resolves with
   * whether it `running`, and the state of the notification permission.
   */
  setBackground(
    options: FxmDownloadsQueueReport,
  ): Promise<{ running: boolean; notifications: FxmPermissionState }>
  /** Asks for the notification permission (Android 13+), so the progress notification shows. */
  requestNotifications(): Promise<{ notifications: FxmPermissionState }>
}

const PLUGIN_METHODS = [
  'info',
  'open',
  'write',
  'truncate',
  'flush',
  'size',
  'close',
  'stat',
  'read',
  'remove',
  'list',
  'exportToMusic',
  'setBackground',
  'requestNotifications',
]

/** The parts of the WebView's global object the plugin lookup reads. */
interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Readonly<Record<string, unknown>>
  }
}

/**
 * The `FxmDownloads` plugin of the Android app, or `undefined` outside it: only on a native
 * Capacitor platform whose bridge has the plugin with all its methods.
 */
export function findFxmDownloadsPlugin(
  global: object = globalThis,
): FxmDownloadsPlugin | undefined {
  const capacitor = (global as CapacitorGlobal).Capacitor
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return undefined
  }
  const plugin = capacitor.Plugins?.[FXM_DOWNLOADS_PLUGIN]
  if (typeof plugin !== 'object' || plugin === null) return undefined
  const methods = plugin as Record<string, unknown>
  return PLUGIN_METHODS.every((name) => typeof methods[name] === 'function')
    ? (plugin as FxmDownloadsPlugin)
    : undefined
}
