/**
 * A fake of the Android app's `FxmDownloads` plugin, for tests of the code that drives it: it
 * keeps files in memory and behaves like `FxmDownloadsPlugin.kt` as far as its callers can tell:
 * one writer per file, a removal of an open file refused, a full storage, base64 on the wire, the
 * bridge's coded errors, the queue reports and the saved songs.
 *
 * @module
 */

import type {
  FxmDownloadsErrorCode,
  FxmDownloadsExport,
  FxmDownloadsPlugin,
  FxmDownloadsQueueReport,
  FxmPermissionState,
} from '../native/plugin'
import { decodeBase64, encodeBase64 } from '../native/storage'
import { isSafeFileName } from '../storage'

/** Where the fake keeps its files: the app's downloads folder on a phone. */
export const FAKE_DOWNLOADS_FOLDER = '/data/user/0/io.github.pratyayops.fxm/files/downloads'

/** A song the fake saved to Music/FXM. */
export interface FakeExport extends FxmDownloadsExport {
  /** Its path there. */
  readonly path: string
  /** Its bytes. */
  readonly bytes: Uint8Array
}

/** The fake plugin, plus ways to look inside it and to make it fail. */
export interface FakeFxmDownloads extends FxmDownloadsPlugin {
  /** The stored files' bytes, by name. */
  readonly files: Map<string, Uint8Array>
  /** The names of the files open for writing. */
  readonly openFiles: ReadonlySet<string>
  /** Every queue report, in order. */
  readonly reports: FxmDownloadsQueueReport[]
  /** Every song saved to Music/FXM, in order. */
  readonly exports: FakeExport[]
  /** The bytes downloads may still take; a write past them fails with `NO_SPACE`. */
  freeBytes: number
  /** The notification permission's state. */
  notifications: FxmPermissionState
  /** Whether the user refuses the permission saving to Music asks for. */
  refuseMusicFolder: boolean
  /** Makes the next call of `method` reject with `code`, once. */
  failNext(method: keyof FxmDownloadsPlugin, code: FxmDownloadsErrorCode): void
  /** Makes every call of `method` hang until `release()` is called. */
  hold(method: keyof FxmDownloadsPlugin): { release(): void }
}

/** The bridge's error: a coded `Error`, as Capacitor rejects with. */
function refusal(code: FxmDownloadsErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Creates a fake `FxmDownloads` plugin with empty storage. */
export function createFakeFxmDownloads(): FakeFxmDownloads {
  const files = new Map<string, Uint8Array>()
  const handles = new Map<string, string>()
  const failures = new Map<string, FxmDownloadsErrorCode>()
  const holds = new Map<string, Promise<void>>()
  let lastHandle = 0

  const enter = async (method: keyof FxmDownloadsPlugin) => {
    const held = holds.get(method)
    if (held !== undefined) await held
    const code = failures.get(method)
    if (code === undefined) return
    failures.delete(method)
    throw refusal(code, `${method} failed (${code})`)
  }
  const name = (file: string) => {
    if (!isSafeFileName(file)) throw refusal('BAD_REQUEST', 'Not a download file name')
    return file
  }
  const fileOf = (handle: string) => {
    const file = handles.get(handle)
    if (file === undefined) throw refusal('NOT_FOUND', `No file is open as ${handle}`)
    return file
  }
  const isOpen = (file: string) => [...handles.values()].includes(file)
  const grow = (file: string, end: number): Uint8Array => {
    const current = files.get(file) ?? new Uint8Array(0)
    if (end <= current.length) return current
    if (end - current.length > fake.freeBytes) {
      throw refusal('NO_SPACE', 'There is no room left for downloads')
    }
    fake.freeBytes -= end - current.length
    const grown = new Uint8Array(end)
    grown.set(current)
    files.set(file, grown)
    return grown
  }

  const fake: FakeFxmDownloads = {
    files,
    get openFiles() {
      return new Set(handles.values())
    },
    reports: [],
    exports: [],
    freeBytes: Number.MAX_SAFE_INTEGER,
    notifications: 'prompt',
    refuseMusicFolder: false,
    failNext(method, code) {
      failures.set(method, code)
    },
    hold(method) {
      let release = () => {}
      holds.set(
        method,
        new Promise<void>((resolve) => {
          release = () => {
            holds.delete(method)
            resolve()
          }
        }),
      )
      return { release: () => release() }
    },

    async info() {
      await enter('info')
      return { available: true, freeBytes: fake.freeBytes, reserveBytes: 500 * 1024 * 1024 }
    },
    async open({ file }) {
      await enter('open')
      name(file)
      if (isOpen(file)) throw refusal('BUSY', `${file} is already open`)
      if (!files.has(file)) files.set(file, new Uint8Array(0))
      lastHandle += 1
      const handle = `w${lastHandle}`
      handles.set(handle, file)
      return { handle, size: files.get(file)?.length ?? 0 }
    },
    async write({ handle, offset, data }) {
      await enter('write')
      const file = fileOf(handle)
      const bytes = decodeBase64(data)
      const target = grow(file, offset + bytes.length)
      target.set(bytes, offset)
      return { size: target.length }
    },
    async truncate({ handle, size }) {
      await enter('truncate')
      const file = fileOf(handle)
      const current = grow(file, size)
      if (size < current.length) {
        fake.freeBytes += current.length - size
        files.set(file, current.slice(0, size))
      }
      return { size }
    },
    async flush({ handle }) {
      await enter('flush')
      fileOf(handle)
    },
    async size({ handle }) {
      await enter('size')
      return { size: files.get(fileOf(handle))?.length ?? 0 }
    },
    async close({ handle }) {
      await enter('close')
      handles.delete(handle)
    },
    async stat({ file }) {
      await enter('stat')
      const bytes = files.get(name(file))
      return bytes === undefined
        ? { size: null, uri: null }
        : { size: bytes.length, uri: `file://${FAKE_DOWNLOADS_FOLDER}/${file}` }
    },
    async read({ file, offset, length }) {
      await enter('read')
      const bytes = files.get(name(file))
      if (bytes === undefined) return { data: null, size: null }
      const chunk = bytes.subarray(offset, offset + Math.min(length, 1024 * 1024))
      return { data: encodeBase64(chunk), size: bytes.length }
    },
    async remove({ file }) {
      await enter('remove')
      if (isOpen(name(file))) throw refusal('BUSY', `${file} is open`)
      const bytes = files.get(file)
      if (bytes !== undefined) fake.freeBytes += bytes.length
      files.delete(file)
    },
    async list() {
      await enter('list')
      return { files: [...files.keys()].sort() }
    },
    async exportToMusic(options) {
      await enter('exportToMusic')
      const bytes = files.get(name(options.file))
      if (bytes === undefined) throw refusal('NOT_FOUND', `${options.file} is gone`)
      if (isOpen(options.file)) throw refusal('BUSY', `${options.file} is still being written`)
      if (options.media !== 'audio') throw refusal('BAD_REQUEST', 'A video file')
      if (fake.refuseMusicFolder) throw refusal('DENIED', 'FXM may not save to the Music folder')
      const credit = options.artists.join(', ')
      const path = `Music/FXM/${credit === '' ? '' : `${credit} - `}${options.title}`
      const saved = { ...options, path, bytes: bytes.slice() }
      fake.exports.push(saved)
      return { uri: `content://media/external_primary/audio/media/${fake.exports.length}`, path }
    },
    async setBackground(report) {
      await enter('setBackground')
      fake.reports.push({ ...report })
      return {
        running: report.downloading > 0 || report.queued > 0,
        notifications: fake.notifications,
      }
    },
    async requestNotifications() {
      await enter('requestNotifications')
      if (fake.notifications !== 'denied') fake.notifications = 'granted'
      return { notifications: fake.notifications }
    },
  }
  return fake
}
