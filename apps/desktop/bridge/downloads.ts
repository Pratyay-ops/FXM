/**
 * Downloads in the desktop app (stage 7.4): the download manager's storage on disk, its network,
 * the downloads folder and "Save to device", over the `fxm-downloads` plugin in
 * `src-tauri/src/downloads.rs`.
 *
 * The download manager (`@fxm/downloads`, stage 4.1) runs in the webview as in a browser; only
 * where its bytes go differs. Files go to the folder the user picks, `Music/FXM` by default:
 *
 * - while a file downloads, it waits in the folder's hidden `.fxm-partial` folder under the
 *   manager's opaque name;
 * - once complete, {@link connectDesktopDownloads} gives it its human name
 *   (`Radiohead - Creep.webm`, {@link downloadFileName}), and Rust moves it into the folder;
 * - offline playback loads it from the `fxm-download:` scheme, by its opaque name, with ranges.
 *
 * Page script never passes a path: the plugin takes the manager's opaque names and file names
 * that Rust makes safe as one name inside the folder. Bytes travel as base64, since the
 * isolation hook refuses byte payloads.
 *
 * @module
 */

import { containerExtension, type Track } from '@fxm/core'
import {
  assertSafeFileName,
  type DownloadFileFormat,
  type DownloadManager,
  type DownloadNetwork,
  type DownloadRecord,
  type DownloadRow,
  type DownloadStorage,
  type DownloadWriter,
  storageFullError,
  storageUnavailableError,
} from '@fxm/downloads'
import {
  commandErrorCode,
  commandErrorMessage,
  DesktopCommandError,
  type Loadable,
  loadOnce,
} from './load-once'
import type { DesktopShell, ShellInvoke } from './shell'

/** The plugin's name: its commands are `plugin:fxm-downloads|<command>`. */
export const DOWNLOADS_PLUGIN = 'fxm-downloads'

/** The plugin's commands (`src-tauri/src/downloads.rs`). */
export const DOWNLOAD_COMMANDS = {
  open: 'open',
  write: 'write',
  truncate: 'truncate',
  flush: 'flush',
  close: 'close',
  remove: 'remove',
  list: 'list',
  size: 'size',
  read: 'read',
  name: 'name',
  folder: 'folder',
  chooseFolder: 'choose_folder',
  saveBegin: 'save_begin',
  saveWrite: 'save_write',
  saveEnd: 'save_end',
} as const

/** The URI scheme offline playback loads complete files from. */
export const DOWNLOAD_SCHEME = 'fxm-download'

/** How long one call may take before it fails as unavailable: 60 s. */
export const DOWNLOAD_CALL_TIMEOUT_MS = 60_000

/** The most bytes one `write` carries: larger writes go as several. */
export const DOWNLOAD_WRITE_BYTES = 4 * 1024 * 1024

/** `plugin:fxm-downloads|<name>`. */
function command(name: (typeof DOWNLOAD_COMMANDS)[keyof typeof DOWNLOAD_COMMANDS]): string {
  return `plugin:${DOWNLOADS_PLUGIN}|${name}`
}

/** What the downloads take from Tauri's JavaScript bindings. */
export interface DownloadBindings {
  /** `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: ShellInvoke
  /** `convertFileSrc` from `@tauri-apps/api/core`: a custom scheme's URL on this system. */
  readonly convertFileSrc: (path: string, protocol: string) => string
}

/** Loads Tauri's bindings. Imported on first use, so a browser never downloads them. */
export async function loadDownloadBindings(): Promise<DownloadBindings> {
  const core = await import('@tauri-apps/api/core')
  return { invoke: core.invoke, convertFileSrc: core.convertFileSrc }
}

/** Base64 for bytes, in slices, so large writes stay within the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

/**
 * A plugin's refusal as the error a `DownloadStorage` gives: a full disk is `storageFullError`
 * (the queue pauses), a folder that is gone or missing, or a plugin that isn't there (an answer
 * without a code), `storageUnavailableError`, a system's refusal `NotAllowedError`, an open file
 * `NoModificationAllowedError` and a missing one `NotFoundError` (as the Origin Private File System
 * says them), a bad name a `TypeError`, anything else a passing problem.
 */
export function desktopStorageError(error: unknown): Error {
  const message = commandErrorMessage(error, 'The downloads folder failed')
  switch (commandErrorCode(error)) {
    case 'storage-full':
      return storageFullError(message)
    case 'folder-missing':
    case 'no-folder':
    case undefined:
      return storageUnavailableError(message)
    case 'denied':
      return new DOMException(message, 'NotAllowedError')
    case 'busy':
      return new DOMException(message, 'NoModificationAllowedError')
    case 'not-found':
      return new DOMException(message, 'NotFoundError')
    case 'not-open':
      return new DOMException(message, 'InvalidStateError')
    case 'bad-request':
      return new TypeError(message)
    default:
      return new Error(message, { cause: error })
  }
}

/**
 * The name a completed download gets in the downloads folder: "Artist A, Artist B - Title.ext",
 * or "Title.ext" without artists, as stage 4.2 names saved copies. The extension is the file's
 * container's (`.webm`, `.m4a`, `.flac`…), and `.mp4` for YouTube's itag 18, a video file. Rust
 * makes the name safe again, and numbers it when another file has it.
 */
export function downloadFileName(
  track: Pick<Track, 'title' | 'artists'>,
  format: Pick<DownloadFileFormat, 'container' | 'codec' | 'media'>,
): string {
  const extension =
    format.media === 'muxed-video' ? 'mp4' : containerExtension(format.container, format.codec)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const forbidden = /[\u0000-\u001f\u007f<>:"/\\|?*]/g
  const clean = (text: string) =>
    text.normalize('NFC').replace(forbidden, ' ').replace(/\s+/g, ' ').trim()
  const artists = clean(
    track.artists
      .map((artist) => artist.name)
      .filter((name) => name.trim() !== '')
      .join(', '),
  )
  const title = clean(track.title)
  const base = artists && title ? `${artists} - ${title}` : title || artists || 'FXM download'
  return `${base}.${extension}`
}

/** What `list` answers: FXM's files that exist, by their opaque names. */
interface Listing {
  partial: string[]
  named: string[]
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function parseListing(value: unknown): Listing {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return { partial: strings(raw.partial), named: strings(raw.named) }
}

/** Options for {@link createDesktopDownloadStorage}. */
export interface DesktopDownloadStorageOptions {
  /** Tauri's bindings. Default: {@link loadDownloadBindings}, on first use. */
  bindings?: Loadable<DownloadBindings>
  /**
   * Every stored download row (`store.rows()` of the manager's `DownloadStore`). `list` reports a
   * named file only when a row names it: when the records are gone (the webview's storage was
   * cleared) but the files are not, the manager's tidy-up would otherwise delete the user's music
   * from the downloads folder. Files on their way are always reported, so the tidy-up deletes
   * those nobody wants.
   */
  rows: () => Promise<readonly Pick<DownloadRow, 'file'>[]>
  /** How long one call may take. Default: {@link DOWNLOAD_CALL_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The desktop app's {@link DownloadStorage}, with a check that it works and the naming step. */
export interface DesktopDownloadStorage extends DownloadStorage {
  /** Whether the downloads folder can be used: there is one. Never rejects. */
  probe(): Promise<boolean>
  /**
   * Gives a completed download's file its human name ({@link downloadFileName}) and moves it
   * into the downloads folder. Answers the name it got, or `undefined` for a record that isn't a
   * completed download. A file that has its name already keeps it.
   */
  name(
    record: Pick<DownloadRecord, 'status' | 'file' | 'format' | 'track'>,
  ): Promise<string | undefined>
}

/**
 * Creates the desktop app's download storage over the `fxm-downloads` plugin (see the module
 * notes). Every call settles: one the plugin doesn't answer within the timeout fails as
 * unavailable.
 */
export function createDesktopDownloadStorage(
  options: DesktopDownloadStorageOptions,
): DesktopDownloadStorage {
  const bindings = loadOnce(options.bindings ?? loadDownloadBindings)
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_CALL_TIMEOUT_MS

  /** The plugin's answer to `name`, with its errors as storage errors, within the timeout. */
  function ask<T>(name: Parameters<typeof command>[0], args: Record<string, unknown> = {}) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(storageUnavailableError('The downloads folder stopped answering')),
        timeoutMs,
      )
      bindings()
        .then(({ invoke }) => invoke<T>(command(name), args))
        .then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error: unknown) => {
            clearTimeout(timer)
            reject(desktopStorageError(error))
          },
        )
    })
  }

  async function size(file: string): Promise<number | undefined> {
    assertSafeFileName(file)
    const answer = await ask<number | null>(DOWNLOAD_COMMANDS.size, { file })
    return typeof answer === 'number' ? answer : undefined
  }

  return {
    async probe() {
      try {
        await ask(DOWNLOAD_COMMANDS.folder)
        return true
      } catch {
        return false
      }
    },

    async open(file): Promise<DownloadWriter> {
      assertSafeFileName(file)
      await ask<number>(DOWNLOAD_COMMANDS.open, { file })
      let closed = false
      const check = () => {
        if (closed) throw new DOMException(`${file} was closed`, 'InvalidStateError')
      }
      return {
        async size() {
          check()
          return (await size(file)) ?? 0
        },
        async write(offset, bytes) {
          check()
          for (let start = 0; start < bytes.length; start += DOWNLOAD_WRITE_BYTES) {
            const slice = bytes.subarray(start, start + DOWNLOAD_WRITE_BYTES)
            await ask(DOWNLOAD_COMMANDS.write, {
              file,
              offset: offset + start,
              data: encodeBase64(slice),
            })
          }
        },
        async truncate(length) {
          check()
          await ask(DOWNLOAD_COMMANDS.truncate, { file, size: length })
        },
        async flush() {
          check()
          await ask(DOWNLOAD_COMMANDS.flush, { file })
        },
        async close() {
          if (closed) return
          closed = true
          await ask(DOWNLOAD_COMMANDS.close, { file })
        },
      }
    },

    async remove(file) {
      assertSafeFileName(file)
      await ask(DOWNLOAD_COMMANDS.remove, { file })
    },

    async list() {
      const listing = parseListing(await ask<unknown>(DOWNLOAD_COMMANDS.list))
      if (listing.named.length === 0) return listing.partial
      const named = new Set((await options.rows()).flatMap((row) => row.file ?? []))
      return [...listing.partial, ...listing.named.filter((file) => named.has(file))]
    },

    size,

    async read(file, type) {
      assertSafeFileName(file)
      try {
        const bytes = await ask<ArrayBuffer>(DOWNLOAD_COMMANDS.read, { file })
        return new Blob([bytes], { type })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
        throw error
      }
    },

    async playbackUrl(file, type) {
      if ((await size(file)) === undefined) return undefined
      const { convertFileSrc } = await bindings()
      // The same file keeps its URL, so a copy that failed to play is recognized.
      return `${convertFileSrc(file, DOWNLOAD_SCHEME)}?type=${encodeURIComponent(type)}`
    },

    async name(record) {
      if (record.status !== 'completed' || record.file === undefined) return undefined
      if (record.format === undefined) return undefined
      assertSafeFileName(record.file)
      return ask<string>(DOWNLOAD_COMMANDS.name, {
        file: record.file,
        fileName: downloadFileName(record.track, record.format),
      })
    },
  }
}

/** Options for {@link connectDesktopDownloads}. */
export interface ConnectDesktopDownloadsOptions {
  /** Where a naming that failed is reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/**
 * Names each download as it completes, in the manager that runs the queue, and at once every
 * completed download still waiting for its name (FXM quit between the two). Returns a function
 * that stops it.
 */
export function connectDesktopDownloads(
  manager: Pick<DownloadManager, 'on' | 'list'>,
  storage: Pick<DesktopDownloadStorage, 'name'>,
  options: ConnectDesktopDownloadsOptions = {},
): () => void {
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  const name = (record: DownloadRecord) => {
    storage.name(record).catch(onError)
  }
  const stop = manager.on('completed', name)
  manager.list().then((records) => {
    for (const record of records) if (record.status === 'completed') name(record)
  }, onError)
  return stop
}

/** Options for {@link createDesktopDownloadNetwork}. */
export interface DesktopDownloadNetworkOptions {
  /** The desktop shell, whose native network notifications count as changes. */
  shell: Pick<DesktopShell, 'onNetworkChange'>
  /** Where `online` and `offline` fire. Default: the page (`globalThis`). */
  target?: EventTarget
  /** Where `onLine` is read. Default: the page's `navigator`. */
  navigator?: { readonly onLine?: boolean }
}

/**
 * The download manager's network in the desktop app: online as the webview says, and a change
 * whenever it goes online or offline or the shell sees the route change (a new Wi-Fi network, a
 * cable, a VPN), so a queue waiting for the network tries again at once.
 */
export function createDesktopDownloadNetwork(
  options: DesktopDownloadNetworkOptions,
): DownloadNetwork {
  const target = options.target ?? globalThis
  const navigator = () =>
    options.navigator ?? (globalThis as { navigator?: { onLine?: boolean } }).navigator
  return {
    get online() {
      return navigator()?.onLine !== false
    },
    subscribe(listener) {
      const stop = new AbortController()
      const changed = () => listener()
      target.addEventListener('online', changed, { signal: stop.signal })
      target.addEventListener('offline', changed, { signal: stop.signal })
      const stopNative = options.shell.onNetworkChange(changed)
      return () => {
        stop.abort()
        stopNative()
      }
    },
  }
}

/** Where the downloads folder is, as Settings shows it. */
export interface DownloadsFolder {
  /** The folder. */
  readonly path: string
  /** Whether the user chose it, rather than FXM's default (`Music/FXM`). */
  readonly chosen: boolean
}

function parseFolder(value: unknown): DownloadsFolder {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return { path: typeof raw.path === 'string' ? raw.path : '', chosen: raw.chosen === true }
}

/** The downloads folder, for Settings. */
export interface DesktopDownloadsFolder {
  /** Where it is. Rejects with a {@link DesktopCommandError} (`no-folder`) when there is none. */
  current(): Promise<DownloadsFolder>
  /**
   * Asks the user for another folder, in the system's folder picker, for the downloads that
   * start from now on. Resolves with it, or `undefined` if the user cancelled. Rejects with a
   * {@link DesktopCommandError}: `not-focused` (FXM's window isn't in front), `busy` (a picker is
   * open), `dialog`.
   */
  choose(): Promise<DownloadsFolder | undefined>
}

/** The downloads folder over the plugin. */
export function createDesktopDownloadsFolder(
  options: { bindings?: Loadable<DownloadBindings> } = {},
): DesktopDownloadsFolder {
  const bindings = loadOnce(options.bindings ?? loadDownloadBindings)
  const call = async <T>(name: Parameters<typeof command>[0]) => {
    const { invoke } = await bindings()
    try {
      return await invoke<T>(command(name))
    } catch (error) {
      throw new DesktopCommandError(error, 'FXM could not reach the downloads folder')
    }
  }
  return {
    async current() {
      return parseFolder(await call<unknown>(DOWNLOAD_COMMANDS.folder))
    },
    async choose() {
      const answer = await call<unknown>(DOWNLOAD_COMMANDS.chooseFolder)
      return answer === null || answer === undefined ? undefined : parseFolder(answer)
    },
  }
}

/** What is about to be saved: stage 4.2's `SaveRequest`. */
export interface DeviceSaveRequest {
  /** The suggested file name, with its extension. */
  readonly fileName: string
  readonly mimeType: string
  /** The kind of file, e.g. "FLAC audio". */
  readonly description?: string
}

/** Where a file will go, once it is ready: stage 4.2's `SaveTarget`. */
export interface DeviceSaveTarget {
  /** The name the file will most likely get: another file may take it first. */
  readonly fileName: string
  /** Writes the file there. */
  write(blob: Blob): Promise<void>
  /** Gives the place up without writing. */
  discard(): Promise<void>
}

/** Saves files on this device: stage 4.2's `DeviceSaver`, which `setDeviceSaver` takes. */
export interface DesktopDeviceSaver {
  /** Starts a copy in the downloads folder, at once: the desktop app asks nothing. */
  choose(request: DeviceSaveRequest): Promise<DeviceSaveTarget | undefined>
}

/**
 * "Save to device" in the desktop app: a converted copy (stage 4.2) goes into the downloads
 * folder, under its own name, numbered if another file has it, with no dialog. The copy is the
 * user's from then on: the download manager never lists or deletes it.
 */
export function createDesktopDeviceSaver(
  options: { bindings?: Loadable<DownloadBindings> } = {},
): DesktopDeviceSaver {
  const bindings = loadOnce(options.bindings ?? loadDownloadBindings)
  const call = async <T>(name: Parameters<typeof command>[0], args: Record<string, unknown>) => {
    const { invoke } = await bindings()
    try {
      return await invoke<T>(command(name), args)
    } catch (error) {
      throw desktopStorageError(error)
    }
  }
  return {
    async choose(request) {
      const started = (await call<unknown>(DOWNLOAD_COMMANDS.saveBegin, {
        fileName: request.fileName,
      })) as { id?: unknown; fileName?: unknown } | null
      const id = started?.id
      if (typeof id !== 'number') throw new TypeError('The downloads folder started no copy')
      let done = false
      const end = async (keep: boolean) => {
        done = true
        await call(DOWNLOAD_COMMANDS.saveEnd, { id, keep })
      }
      return {
        fileName: typeof started?.fileName === 'string' ? started.fileName : request.fileName,
        async write(blob) {
          if (done) throw new DOMException('The copy was saved or given up', 'InvalidStateError')
          try {
            for (let start = 0; start < blob.size; start += DOWNLOAD_WRITE_BYTES) {
              const bytes = new Uint8Array(
                await blob.slice(start, start + DOWNLOAD_WRITE_BYTES).arrayBuffer(),
              )
              await call(DOWNLOAD_COMMANDS.saveWrite, {
                id,
                offset: start,
                data: encodeBase64(bytes),
              })
            }
          } catch (error) {
            await end(false).catch(() => {})
            throw error
          }
          await end(true)
        },
        async discard() {
          if (done) return
          await end(false)
        },
      }
    },
  }
}
