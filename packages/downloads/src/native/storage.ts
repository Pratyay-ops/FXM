/**
 * The download manager's `DownloadStorage` in the Android app (stage 6.4): files in the app's own
 * storage, written through the `FxmDownloads` plugin. The manager runs in the WebView as it does
 * in a browser, fetching through the app's native HTTP (`FxmHttp`, the shared OkHttp client), so
 * the queue, the end-of-file probe, the fresh resolutions after an expiry and every recovery are
 * 4.1's; only where the bytes go differs.
 *
 * Offline copies play from the device: their playback URL is the WebView URL of the file
 * (`webViewFileUrl` in `@fxm/player`), which the native engine hands Media3 as the file itself
 * and an `<audio>` element loads through Capacitor's local server.
 *
 * @module
 */

import { pageOrigin, webViewFileUrl } from '@fxm/player'
import {
  assertSafeFileName,
  type DownloadStorage,
  type DownloadWriter,
  isSafeFileName,
  storageFullError,
  storageUnavailableError,
} from '../storage'
import {
  FXM_DOWNLOADS_MAX_READ_BYTES,
  type FxmDownloadsPlugin,
  fxmDownloadsErrorCode,
} from './plugin'

/** Options for {@link createNativeDownloadStorage}. */
export interface NativeDownloadStorageOptions {
  /** The plugin. */
  plugin: FxmDownloadsPlugin
  /**
   * The page's origin, for the WebView URLs of files. Default: the page's own; `null` gives the
   * files' own `file:` URIs, which only the native engine plays.
   */
  origin?: string | null
  /** How long one call may take before it fails as unavailable. Default: 60 s. */
  timeoutMs?: number
}

/** A {@link DownloadStorage} in the Android app's storage, and a way to check it works. */
export interface NativeDownloadStorage extends DownloadStorage {
  /** Whether the app's storage can hold downloads. Never rejects. */
  probe(): Promise<boolean>
}

/** The default for {@link NativeDownloadStorageOptions.timeoutMs}. */
const TIMEOUT_MS = 60_000

/** Base64 for bytes, in slices so large writes stay within the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

/** The bytes of a base64 string. */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function messageOf(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : fallback
}

/**
 * The plugin's refusal as the error a `DownloadStorage` gives: a full disk is `storageFullError`
 * (the queue pauses), a storage that can't work `storageUnavailableError`, an open file
 * `NoModificationAllowedError` and a gone one `NotFoundError` (as the Origin Private File System
 * says them), anything else a passing problem. A failure without the plugin's code (the bridge
 * without the plugin) is unavailable too.
 */
export function nativeStorageError(error: unknown): Error {
  const message = messageOf(error, 'The app’s storage failed')
  switch (fxmDownloadsErrorCode(error)) {
    case 'NO_SPACE':
      return storageFullError(message)
    case 'UNAVAILABLE':
    case undefined:
      return storageUnavailableError(message)
    case 'BUSY':
      return new DOMException(message, 'NoModificationAllowedError')
    case 'NOT_FOUND':
      return new DOMException(message, 'NotFoundError')
    case 'DENIED':
      return new DOMException(message, 'NotAllowedError')
    case 'BAD_REQUEST':
      return new TypeError(message)
    default:
      return new Error(message, { cause: error })
  }
}

/**
 * Creates the Android app's download storage over the plugin: see the module notes. Every call
 * settles: one the plugin doesn't answer within the timeout fails as unavailable.
 */
export function createNativeDownloadStorage(
  options: NativeDownloadStorageOptions,
): NativeDownloadStorage {
  const { plugin } = options
  const origin = options.origin === undefined ? (pageOrigin() ?? null) : options.origin
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS

  /** The plugin's answer to `call`, with its errors as storage errors, within the timeout. */
  function ask<T>(call: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(storageUnavailableError('The app’s storage stopped answering')),
        timeoutMs,
      )
      Promise.resolve()
        .then(call)
        .then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error: unknown) => {
            clearTimeout(timer)
            reject(nativeStorageError(error))
          },
        )
    })
  }

  function writer(file: string, handle: string): DownloadWriter {
    let closed = false
    const check = () => {
      if (closed) throw new DOMException(`${file} was closed`, 'InvalidStateError')
    }
    return {
      async size() {
        check()
        return (await ask(() => plugin.size({ handle }))).size
      },
      async write(offset, bytes) {
        check()
        await ask(() => plugin.write({ handle, offset, data: encodeBase64(bytes) }))
      },
      async truncate(size) {
        check()
        await ask(() => plugin.truncate({ handle, size }))
      },
      async flush() {
        check()
        await ask(() => plugin.flush({ handle }))
      },
      async close() {
        if (closed) return
        closed = true
        await ask(() => plugin.close({ handle }))
      },
    }
  }

  async function stat(file: string): Promise<{ size: number; uri: string } | undefined> {
    assertSafeFileName(file)
    const { size, uri } = await ask(() => plugin.stat({ file }))
    return size === null || uri === null ? undefined : { size, uri }
  }

  return {
    async probe() {
      try {
        return (await ask(() => plugin.info())).available === true
      } catch {
        return false
      }
    },
    async open(file) {
      assertSafeFileName(file)
      const { handle } = await ask(() => plugin.open({ file }))
      return writer(file, handle)
    },
    async remove(file) {
      assertSafeFileName(file)
      await ask(() => plugin.remove({ file }))
    },
    async list() {
      return (await ask(() => plugin.list())).files.filter(isSafeFileName)
    },
    async size(file) {
      return (await stat(file))?.size
    },
    async read(file, type) {
      const found = await stat(file)
      if (found === undefined) return undefined
      const parts: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      while (offset < found.size) {
        const { data } = await ask(() =>
          plugin.read({ file, offset, length: FXM_DOWNLOADS_MAX_READ_BYTES }),
        )
        // Gone, or shorter than it was: what was read is all there is.
        if (data === null) return undefined
        const bytes = decodeBase64(data)
        if (bytes.length === 0) break
        parts.push(bytes)
        offset += bytes.length
      }
      return new Blob(parts, { type })
    },
    async playbackUrl(file) {
      const found = await stat(file)
      if (found === undefined) return undefined
      return webViewFileUrl(found.uri, origin) ?? found.uri
    },
  }
}
