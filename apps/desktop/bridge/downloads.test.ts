import type { NetworkCapabilities, ProviderContext, Track } from '@fxm/core'
import {
  createMemoryDownloadStore,
  createOfflineStore,
  DownloadManager,
  type DownloadRecord,
  type DownloadStore,
  downloadId,
  isStorageFullError,
  isStorageUnavailableError,
} from '@fxm/downloads'
import {
  downloadCandidate,
  downloadStream,
  FakeDownloadResolver,
  FakeMediaServer,
  FakeNetwork,
  testBytes,
} from '@fxm/downloads/testing'
import { testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectDesktopDownloads,
  createDesktopDeviceSaver,
  createDesktopDownloadNetwork,
  createDesktopDownloadStorage,
  createDesktopDownloadsFolder,
  DOWNLOAD_COMMANDS,
  DOWNLOAD_SCHEME,
  DOWNLOAD_WRITE_BYTES,
  DOWNLOADS_PLUGIN,
  type DownloadBindings,
  desktopStorageError,
  downloadFileName,
  encodeBase64,
} from './downloads'
import { DesktopCommandError } from './load-once'

/** What the desktop app reaches: everything, bytes and files included. */
const DESKTOP: NetworkCapabilities = {
  youtube: 'full',
  spotify: 'anonymous',
  mediaBytes: true,
  fileSystem: true,
}

const bytes = (...values: number[]) => new Uint8Array(values)

/** Lets the event loop run: calls that were going to happen have happened. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}

/** An error as a Rust command answers it. */
const refusal = (code: string, message = code) => ({ code, message })

/**
 * The `fxm-downloads` plugin in memory, with the Rust side's rules: one writer per file, files
 * on their way until named, a name numbered when taken, copies saved apart from downloads.
 */
function fakePlugin() {
  const files = new Map<string, { bytes: Uint8Array; named?: string }>()
  const open = new Set<string>()
  const taken = new Set<string>()
  const saved = new Map<string, Uint8Array>()
  const saves = new Map<number, { fileName: string; bytes: Uint8Array }>()
  const failures = new Map<string, unknown>()
  const held = new Set<string>()
  const waiting = new Map<string, (() => void)[]>()
  const answers = new Map<string, unknown>()
  const calls: { command: string; args: Record<string, unknown> }[] = []
  let folder: { path: string; chosen: boolean } | undefined = {
    path: '/Users/me/Music/FXM',
    chosen: false,
  }
  let picked: { path: string; chosen: boolean } | null = null
  let nextSave = 0

  const grow = (target: Uint8Array, offset: number, data: Uint8Array) => {
    const next = new Uint8Array(Math.max(target.length, offset + data.length))
    next.set(target)
    next.set(data, offset)
    return next
  }
  const freeName = (fileName: string) => {
    const dot = fileName.lastIndexOf('.')
    const [stem, extension] = [fileName.slice(0, dot), fileName.slice(dot)]
    let name = fileName
    for (let number = 2; taken.has(name); number += 1) name = `${stem} (${number})${extension}`
    return name
  }
  const file = (args: Record<string, unknown>) => {
    const name = args.file as string
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw refusal('bad-request')
    return name
  }

  async function invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    calls.push({ command, args })
    const prefix = `plugin:${DOWNLOADS_PLUGIN}|`
    if (!command.startsWith(prefix)) throw new Error(`${command} not allowed`)
    const name = command.slice(prefix.length)
    if (held.has(name)) {
      await new Promise<void>((resolve) =>
        waiting.set(name, [...(waiting.get(name) ?? []), resolve]),
      )
    }
    const failure = failures.get(name)
    if (failure !== undefined) {
      failures.delete(name)
      throw failure
    }
    if (answers.has(name)) return answers.get(name)
    switch (name) {
      case DOWNLOAD_COMMANDS.folder:
        if (folder === undefined) throw refusal('no-folder')
        return folder
      case DOWNLOAD_COMMANDS.chooseFolder:
        if (picked !== null) folder = picked
        return picked
      case DOWNLOAD_COMMANDS.open: {
        const key = file(args)
        if (open.has(key)) throw refusal('busy')
        open.add(key)
        if (!files.has(key)) files.set(key, { bytes: new Uint8Array(0) })
        return files.get(key)?.bytes.length
      }
      case DOWNLOAD_COMMANDS.write: {
        const key = file(args)
        const entry = files.get(key)
        if (!open.has(key) || entry === undefined) throw refusal('not-open')
        entry.bytes = grow(entry.bytes, args.offset as number, decodeBase64(args.data as string))
        return null
      }
      case DOWNLOAD_COMMANDS.truncate: {
        const entry = files.get(file(args))
        if (entry === undefined) throw refusal('not-open')
        entry.bytes = entry.bytes.slice(0, args.size as number)
        return null
      }
      case DOWNLOAD_COMMANDS.flush:
        return null
      case DOWNLOAD_COMMANDS.close:
        open.delete(file(args))
        return null
      case DOWNLOAD_COMMANDS.remove: {
        const key = file(args)
        if (open.has(key)) throw refusal('busy')
        const named = files.get(key)?.named
        if (named !== undefined) taken.delete(named)
        files.delete(key)
        return null
      }
      case DOWNLOAD_COMMANDS.list: {
        const keys = [...files.keys()].sort()
        return {
          partial: keys.filter((key) => files.get(key)?.named === undefined),
          named: keys.filter((key) => files.get(key)?.named !== undefined),
        }
      }
      case DOWNLOAD_COMMANDS.size:
        return files.get(file(args))?.bytes.length ?? null
      case DOWNLOAD_COMMANDS.read: {
        const entry = files.get(file(args))
        if (entry === undefined) throw refusal('not-found')
        return entry.bytes.slice().buffer
      }
      case DOWNLOAD_COMMANDS.name: {
        const key = file(args)
        const entry = files.get(key)
        if (entry === undefined) throw refusal('not-found')
        if (open.has(key)) throw refusal('busy')
        if (entry.named === undefined) {
          entry.named = freeName(args.fileName as string)
          taken.add(entry.named)
        }
        return entry.named
      }
      case DOWNLOAD_COMMANDS.saveBegin: {
        nextSave += 1
        saves.set(nextSave, { fileName: args.fileName as string, bytes: new Uint8Array(0) })
        return { id: nextSave, fileName: freeName(args.fileName as string) }
      }
      case DOWNLOAD_COMMANDS.saveWrite: {
        const save = saves.get(args.id as number)
        if (save === undefined) throw refusal('not-open')
        save.bytes = grow(save.bytes, args.offset as number, decodeBase64(args.data as string))
        return null
      }
      case DOWNLOAD_COMMANDS.saveEnd: {
        const save = saves.get(args.id as number)
        if (save === undefined) throw refusal('not-open')
        saves.delete(args.id as number)
        if (args.keep !== true) return null
        const finalName = freeName(save.fileName)
        taken.add(finalName)
        saved.set(finalName, save.bytes)
        return finalName
      }
      default:
        throw new Error(`no command ${name}`)
    }
  }

  const bindings: DownloadBindings = {
    invoke: vi.fn(invoke) as unknown as DownloadBindings['invoke'],
    convertFileSrc: (path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`,
  }
  return {
    bindings,
    files,
    open,
    taken,
    saved,
    saves,
    calls,
    /** Makes the next call of `command` fail with `error`, once. */
    failNext(command: string, error: unknown) {
      failures.set(command, error)
    },
    /** Makes every call of `command` hang, until {@link release}. */
    hold(command: string) {
      held.add(command)
    },
    /** Answers the calls of `command` held so far, and no longer holds the next. */
    release(command: string) {
      held.delete(command)
      for (const resolve of waiting.get(command) ?? []) resolve()
      waiting.delete(command)
    },
    /** Makes every call of `command` answer `answer`, as a faulty or other IPC might. */
    answer(command: string, answer: unknown) {
      answers.set(command, answer)
    },
    setFolder(next: typeof folder) {
      folder = next
    },
    /** What the folder picker answers: a folder, or `null` for Cancel. */
    pick(next: typeof picked) {
      picked = next
    },
    callsOf(command: string) {
      return calls.filter((call) => call.command === `plugin:${DOWNLOADS_PLUGIN}|${command}`)
    },
  }
}

/** A manager over the desktop storage (a fake plugin), as the desktop app builds it. */
function desktop(options: { store?: DownloadStore; plugin?: ReturnType<typeof fakePlugin> } = {}) {
  const plugin = options.plugin ?? fakePlugin()
  const store = options.store ?? createMemoryDownloadStore()
  const storage = createDesktopDownloadStorage({
    bindings: plugin.bindings,
    rows: () => store.rows(),
  })
  const server = new FakeMediaServer({ pieceBytes: 256 })
  const content = new Map<string, Uint8Array<ArrayBuffer>>()
  const url = (track: Track, call: number) =>
    `https://media.test/${encodeURIComponent(downloadCandidate(track).ref)}?n=${call}`
  const resolver = new FakeDownloadResolver((track, _request, call) => {
    const file = content.get(track.id)
    if (file !== undefined) server.add(url(track, call), file)
    return { candidate: downloadCandidate(track), stream: downloadStream(url(track, call)) }
  })
  const network = new FakeNetwork()
  let names = 0
  const context = (): ProviderContext => ({
    fetch: (input, init) => server.fetch(input, init),
    platform: 'desktop',
    capabilities: DESKTOP,
    mode: 'music',
  })
  const manager = new DownloadManager({
    store,
    storage,
    resolver,
    network,
    context,
    chunkBytes: 1024,
    retryDelaysMs: [0],
    createFileName: () => {
      names += 1
      return `file-${names}`
    },
  })
  return {
    plugin,
    store,
    storage,
    manager,
    context,
    serve(track: Track, size = 5000) {
      const file = testBytes(size, track.title.length)
      content.set(track.id, file)
      return file
    },
    record: (track: Track) => store.get(downloadId(track)),
  }
}

const creep = testTrack('Creep', { artists: [{ name: 'Radiohead' }] })

const managers: DownloadManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.destroy()
})

describe('downloads in the desktop app', () => {
  it('land in the downloads folder under their human names and play offline from there', async () => {
    const h = desktop()
    managers.push(h.manager)
    const content = h.serve(creep)
    const stop = connectDesktopDownloads(h.manager, h.storage)
    await h.manager.start()
    await h.manager.enqueue(creep)
    await h.manager.idle()
    const record = await h.record(creep)
    expect(record).toMatchObject({ status: 'completed', file: 'file-1', bytesDone: 5000 })
    await vi.waitFor(() => expect(h.plugin.files.get('file-1')?.named).toBeDefined())
    expect(h.plugin.files.get('file-1')).toEqual({
      bytes: content,
      named: 'Radiohead - Creep.webm',
    })
    // Bytes went as base64, at most 4 MiB a call, and never as a byte payload.
    for (const call of h.plugin.callsOf(DOWNLOAD_COMMANDS.write)) {
      expect(typeof call.args.data).toBe('string')
    }
    const offline = createOfflineStore({ store: h.store, storage: h.storage })
    const stream = await offline.find(creep, h.context())
    expect(stream?.url).toBe(
      `${DOWNLOAD_SCHEME}://localhost/file-1?type=${encodeURIComponent('audio/webm; codecs="opus"')}`,
    )
    expect(stream?.fullLength).toBe('verified')
    stop()
  })

  it('names the downloads that completed while FXM was away, once it starts again', async () => {
    const first = desktop()
    managers.push(first.manager)
    first.serve(creep)
    await first.manager.start()
    await first.manager.enqueue(creep)
    await first.manager.idle()
    // Not connected: as if FXM quit before naming the file.
    expect(first.plugin.files.get('file-1')?.named).toBeUndefined()
    await first.manager.stop()
    const again = desktop({ store: first.store, plugin: first.plugin })
    managers.push(again.manager)
    await again.manager.start()
    connectDesktopDownloads(again.manager, again.storage)
    await vi.waitFor(() =>
      expect(again.plugin.files.get('file-1')?.named).toBe('Radiohead - Creep.webm'),
    )
  })

  it('names at start the downloads still waiting only, from one listing, one at a time', async () => {
    const first = desktop()
    managers.push(first.manager)
    const songs = ['Creep', 'Karma Police', 'No Surprises'].map((title) =>
      testTrack(title, { artists: [{ name: 'Radiohead' }] }),
    )
    for (const song of songs) first.serve(song)
    await first.manager.start()
    for (const song of songs) await first.manager.enqueue(song)
    await first.manager.idle()
    // One was named before FXM quit; two still wait in `.fxm-partial`.
    const [named] = await first.manager.list()
    if (named !== undefined) await first.storage.name(named)
    await first.manager.stop()
    const plugin = first.plugin
    const again = desktop({ store: first.store, plugin })
    managers.push(again.manager)
    await again.manager.start()
    const namings = () => plugin.callsOf(DOWNLOAD_COMMANDS.name).length
    const listings = () => plugin.callsOf(DOWNLOAD_COMMANDS.list).length
    const [names, lists] = [namings(), listings()]
    plugin.hold(DOWNLOAD_COMMANDS.name)
    connectDesktopDownloads(again.manager, again.storage)
    await vi.waitFor(() => expect(namings()).toBe(names + 1))
    await flush()
    // The next waits for this one.
    expect(namings()).toBe(names + 1)
    plugin.release(DOWNLOAD_COMMANDS.name)
    await vi.waitFor(() =>
      expect([...plugin.files.values()].every((file) => file.named !== undefined)).toBe(true),
    )
    expect(namings()).toBe(names + 2)
    expect(listings()).toBe(lists + 1)
  })

  it('never lets the tidy-up delete a named file that no record knows', async () => {
    const first = desktop()
    managers.push(first.manager)
    first.serve(creep)
    connectDesktopDownloads(first.manager, first.storage)
    await first.manager.start()
    await first.manager.enqueue(creep)
    await first.manager.idle()
    await vi.waitFor(() => expect(first.plugin.files.get('file-1')?.named).toBeDefined())
    await first.manager.stop()
    const plugin = first.plugin
    // A named file whose record is gone (the webview's storage was cleared), and a file on its
    // way that nobody wants.
    plugin.files.set('lost-record', { bytes: bytes(1), named: 'Someone - Something.webm' })
    plugin.files.set('orphan', { bytes: bytes(2) })
    const again = desktop({ store: first.store, plugin })
    managers.push(again.manager)
    await again.manager.start()
    expect(plugin.files.has('lost-record')).toBe(true)
    expect(plugin.files.has('orphan')).toBe(false)
    // The completed download's file is still there and still counts as complete.
    expect(await again.record(creep)).toMatchObject({ status: 'completed', file: 'file-1' })
    // With every record gone, nothing named is deleted either.
    const wiped = desktop({ store: createMemoryDownloadStore(), plugin })
    managers.push(wiped.manager)
    await wiped.manager.start()
    expect(plugin.files.has('file-1')).toBe(true)
    expect(plugin.files.has('lost-record')).toBe(true)
  })

  it('skips the tidy-up on a malformed list rather than mark every download missing', async () => {
    const first = desktop()
    managers.push(first.manager)
    first.serve(creep)
    connectDesktopDownloads(first.manager, first.storage)
    await first.manager.start()
    await first.manager.enqueue(creep)
    await first.manager.idle()
    await vi.waitFor(() => expect(first.plugin.files.get('file-1')?.named).toBeDefined())
    await first.manager.stop()
    for (const malformed of [
      null,
      {},
      { partial: [], named: 'file-1' },
      { partial: [1], named: [] },
    ]) {
      first.plugin.answer(DOWNLOAD_COMMANDS.list, malformed)
      await expect(first.storage.list()).rejects.toBeInstanceOf(TypeError)
      await expect(first.storage.pending()).rejects.toBeInstanceOf(TypeError)
    }
    const again = desktop({ store: first.store, plugin: first.plugin })
    managers.push(again.manager)
    await again.manager.start()
    expect(await again.record(creep)).toMatchObject({ status: 'completed', file: 'file-1' })
    expect(first.plugin.files.has('file-1')).toBe(true)
  })

  it('removes a download’s named file when the user removes the download', async () => {
    const h = desktop()
    managers.push(h.manager)
    h.serve(creep)
    connectDesktopDownloads(h.manager, h.storage)
    await h.manager.start()
    await h.manager.enqueue(creep)
    await h.manager.idle()
    await vi.waitFor(() => expect(h.plugin.files.get('file-1')?.named).toBeDefined())
    await h.manager.remove(downloadId(creep))
    await h.manager.idle()
    await vi.waitFor(() => expect(h.plugin.files.has('file-1')).toBe(false))
    expect(await h.record(creep)).toBeUndefined()
  })

  it('pauses the queue on a full disk and fails a download whose folder is gone', async () => {
    const full = desktop()
    managers.push(full.manager)
    full.serve(creep)
    full.plugin.failNext(DOWNLOAD_COMMANDS.write, refusal('storage-full', 'No space left'))
    await full.manager.start()
    await full.manager.enqueue(creep)
    await full.manager.idle()
    expect((await full.record(creep))?.error?.code).toBe('storage-full')

    const gone = desktop()
    managers.push(gone.manager)
    gone.serve(creep)
    gone.plugin.failNext(DOWNLOAD_COMMANDS.open, refusal('folder-missing', 'Connect its drive'))
    await gone.manager.start()
    await gone.manager.enqueue(creep)
    await gone.manager.idle()
    const failed: DownloadRecord | undefined = await gone.record(creep)
    expect(failed?.status).toBe('failed')
    expect(failed?.error?.code).toBe('storage')
  })
})

describe('the desktop download storage', () => {
  const storageOver = (plugin: ReturnType<typeof fakePlugin>, timeoutMs?: number) =>
    createDesktopDownloadStorage({
      bindings: plugin.bindings,
      rows: async () => [],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })

  it('writes, truncates, flushes and reads a file', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    expect(await storage.probe()).toBe(true)
    const writer = await storage.open('a-1')
    expect(await writer.size()).toBe(0)
    await writer.write(0, bytes(1, 2, 3))
    await writer.write(5, bytes(9))
    expect(await writer.size()).toBe(6)
    expect(plugin.files.get('a-1')?.bytes).toEqual(bytes(1, 2, 3, 0, 0, 9))
    await writer.truncate(4)
    await writer.flush()
    await writer.close()
    await writer.close()
    await expect(writer.write(0, bytes(1))).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(await storage.size('a-1')).toBe(4)
    expect(await storage.size('b')).toBeUndefined()
    expect(await storage.list()).toEqual(['a-1'])
    const blob = await storage.read('a-1', 'audio/flac')
    expect(blob?.type).toBe('audio/flac')
    expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      bytes(1, 2, 3, 0),
    )
    expect(await storage.read('b', 'audio/flac')).toBeUndefined()
  })

  it('sends a large write as several calls of at most 4 MiB', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    const writer = await storage.open('big')
    const content = testBytes(DOWNLOAD_WRITE_BYTES + 1000)
    await writer.write(10, content)
    const writes = plugin.callsOf(DOWNLOAD_COMMANDS.write)
    expect(writes.map((call) => call.args.offset)).toEqual([10, 10 + DOWNLOAD_WRITE_BYTES])
    const stored = plugin.files.get('big')?.bytes ?? new Uint8Array(0)
    expect(stored.length).toBe(10 + content.length)
    // Compared in a loop: a deep comparison of megabytes takes seconds.
    expect(content.every((byte, index) => stored[10 + index] === byte)).toBe(true)
  })

  it('hands out one URL per complete file, on the fxm-download scheme', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    plugin.files.set('a-1', { bytes: bytes(1), named: 'Song.webm' })
    const url = await storage.playbackUrl('a-1', 'audio/webm; codecs="opus"')
    expect(url).toBe('fxm-download://localhost/a-1?type=audio%2Fwebm%3B%20codecs%3D%22opus%22')
    expect(await storage.playbackUrl('a-1', 'audio/webm; codecs="opus"')).toBe(url)
    expect(await storage.playbackUrl('gone', 'audio/webm')).toBeUndefined()
  })

  it('refuses names the manager never gives before it calls the plugin', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    await expect(storage.open('../escape')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.remove('a.b')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.size('con')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.read('a/b', 'audio/mpeg')).rejects.toBeInstanceOf(TypeError)
    await expect(storage.playbackUrl('', 'audio/mpeg')).rejects.toBeInstanceOf(TypeError)
    expect(plugin.calls).toEqual([])
  })

  it('reports named files only when a record names them', async () => {
    const plugin = fakePlugin()
    plugin.files.set('partial', { bytes: bytes(1) })
    plugin.files.set('known', { bytes: bytes(1), named: 'A.webm' })
    plugin.files.set('unknown', { bytes: bytes(1), named: 'B.webm' })
    const storage = createDesktopDownloadStorage({
      bindings: plugin.bindings,
      rows: async () => [{ file: 'known' }, {}],
    })
    expect(await storage.list()).toEqual(['partial', 'known'])
  })

  it('names only completed downloads, after their artists and title', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    plugin.files.set('a', { bytes: bytes(1) })
    const format = { codec: 'aac', container: 'mp4', media: 'audio', tier: 'high' } as const
    const record = { status: 'completed', file: 'a', format, track: creep } as const
    expect(await storage.name({ ...record, status: 'downloading' })).toBeUndefined()
    expect(await storage.name({ status: 'completed', track: creep, format })).toBeUndefined()
    expect(await storage.name(record)).toBe('Radiohead - Creep.m4a')
    expect(plugin.callsOf(DOWNLOAD_COMMANDS.name)[0]?.args).toEqual({
      file: 'a',
      fileName: 'Radiohead - Creep.m4a',
    })
    plugin.answer(DOWNLOAD_COMMANDS.name, 42)
    await expect(storage.name(record)).rejects.toBeInstanceOf(TypeError)
  })

  it('reads the bytes however the IPC delivers them, and nothing else', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    const answers: unknown[] = [
      bytes(1, 2, 3).buffer,
      bytes(0, 1, 2, 3, 4).subarray(1, 4),
      new DataView(bytes(9, 1, 2, 3).buffer, 1),
      // Tauri's postMessage fallback.
      [1, 2, 3],
    ]
    for (const answer of answers) {
      plugin.answer(DOWNLOAD_COMMANDS.read, answer)
      const blob = await storage.read('a', 'audio/mpeg')
      expect(blob?.type).toBe('audio/mpeg')
      expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
        bytes(1, 2, 3),
      )
    }
    for (const answer of ['1,2,3', { 0: 1 }, [1, 256], [1.5], [-1], null]) {
      plugin.answer(DOWNLOAD_COMMANDS.read, answer)
      await expect(storage.read('a', 'audio/mpeg'), JSON.stringify(answer)).rejects.toBeInstanceOf(
        TypeError,
      )
    }
  })

  it('closes a file whose open the app answers only after the call gave up', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin, 1000)
    plugin.hold(DOWNLOAD_COMMANDS.open)
    vi.useFakeTimers()
    const opening = storage.open('late').catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(1000)
    } finally {
      vi.useRealTimers()
    }
    expect(isStorageUnavailableError(await opening)).toBe(true)
    // Rust opens it after all: the writer no one holds is closed, and the file is free again.
    plugin.release(DOWNLOAD_COMMANDS.open)
    await vi.waitFor(() => expect(plugin.callsOf(DOWNLOAD_COMMANDS.close)).toHaveLength(1))
    expect(plugin.callsOf(DOWNLOAD_COMMANDS.close)[0]?.args).toEqual({ file: 'late' })
    expect(plugin.open.has('late')).toBe(false)
    const writer = await storage.open('late')
    await writer.close()
  })

  it('speaks the storage errors the manager acts on', async () => {
    const plugin = fakePlugin()
    const storage = storageOver(plugin)
    const writer = await storage.open('a')
    await expect(storage.open('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    await expect(storage.remove('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    plugin.failNext(DOWNLOAD_COMMANDS.write, refusal('storage-full'))
    expect(isStorageFullError(await writer.write(0, bytes(1)).catch((e: unknown) => e))).toBe(true)
    plugin.failNext(DOWNLOAD_COMMANDS.flush, refusal('storage'))
    const passing = await writer.flush().catch((error: unknown) => error)
    expect(passing).toBeInstanceOf(Error)
    expect(isStorageFullError(passing) || isStorageUnavailableError(passing)).toBe(false)
    for (const code of ['folder-missing', 'no-folder']) {
      expect(isStorageUnavailableError(desktopStorageError(refusal(code)))).toBe(true)
    }
    // A refusal without a code: the IPC refused the command, or there is no such plugin.
    expect(isStorageUnavailableError(desktopStorageError('command not allowed'))).toBe(true)
    expect(desktopStorageError(refusal('denied'))).toMatchObject({ name: 'NotAllowedError' })
    expect(desktopStorageError(refusal('not-found'))).toMatchObject({ name: 'NotFoundError' })
    expect(desktopStorageError(refusal('not-open'))).toMatchObject({ name: 'InvalidStateError' })
    expect(desktopStorageError(refusal('bad-request'))).toBeInstanceOf(TypeError)
    plugin.setFolder(undefined)
    expect(await storage.probe()).toBe(false)
  })

  it('settles every call, also one the app never answers', async () => {
    vi.useFakeTimers()
    try {
      const plugin = fakePlugin()
      const storage = storageOver(plugin, 1000)
      plugin.hold(DOWNLOAD_COMMANDS.list)
      const listing = storage.list().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1000)
      expect(isStorageUnavailableError(await listing)).toBe(true)
      plugin.hold(DOWNLOAD_COMMANDS.folder)
      const probe = storage.probe()
      await vi.advanceTimersByTimeAsync(1000)
      expect(await probe).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('encodes bytes as base64, also past the argument limit of one call', () => {
    expect(encodeBase64(bytes())).toBe('')
    expect(encodeBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=')
    const large = testBytes(100_000)
    expect(decodeBase64(encodeBase64(large))).toEqual(large)
  })
})

describe('downloadFileName', () => {
  const format = (container: 'webm' | 'mp4' | 'ogg' | 'flac', media = 'audio' as const) =>
    ({ codec: container === 'flac' ? 'flac' : 'opus', container, media }) as const

  it('names a file after its artists and title, with its container’s extension', () => {
    expect(downloadFileName(creep, format('webm'))).toBe('Radiohead - Creep.webm')
    expect(
      downloadFileName(
        { title: 'Under Pressure', artists: [{ name: 'Queen' }, { name: 'David Bowie' }] },
        format('flac'),
      ),
    ).toBe('Queen, David Bowie - Under Pressure.flac')
    expect(downloadFileName({ title: 'Song', artists: [] }, format('ogg'))).toBe('Song.opus')
    expect(downloadFileName({ title: '', artists: [] }, format('webm'))).toBe('FXM download.webm')
  })

  it('names YouTube’s itag 18 for what it is: a video file', () => {
    expect(downloadFileName(creep, { codec: 'aac', container: 'mp4', media: 'muxed-video' })).toBe(
      'Radiohead - Creep.mp4',
    )
    expect(downloadFileName(creep, { codec: 'aac', container: 'mp4', media: 'audio' })).toBe(
      'Radiohead - Creep.m4a',
    )
  })

  it('leaves out what file systems refuse', () => {
    expect(
      downloadFileName(
        { title: 'AC/DC: "Live"?\n', artists: [{ name: 'a\\b|c*' }] },
        format('webm'),
      ),
    ).toBe('a b c - AC DC Live.webm')
  })
})

describe('the desktop download network', () => {
  it('is online as the webview says, and changes with it and the native route', () => {
    const target = new EventTarget()
    const navigator = { onLine: true }
    let native: (() => void) | undefined
    const stopNative = vi.fn()
    const network = createDesktopDownloadNetwork({
      shell: {
        onNetworkChange: (listener) => {
          native = listener
          return stopNative
        },
      },
      target,
      navigator,
    })
    expect(network.online).toBe(true)
    const listener = vi.fn()
    const stop = network.subscribe(listener)
    navigator.onLine = false
    target.dispatchEvent(new Event('offline'))
    expect(network.online).toBe(false)
    navigator.onLine = true
    target.dispatchEvent(new Event('online'))
    native?.()
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    expect(stopNative).toHaveBeenCalled()
    target.dispatchEvent(new Event('offline'))
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('the downloads folder', () => {
  it('says where it is, and asks the user for another', async () => {
    const plugin = fakePlugin()
    const folder = createDesktopDownloadsFolder({ bindings: plugin.bindings })
    expect(await folder.current()).toEqual({ path: '/Users/me/Music/FXM', chosen: false })
    expect(await folder.choose()).toBeUndefined()
    plugin.pick({ path: '/Volumes/Music', chosen: true })
    expect(await folder.choose()).toEqual({ path: '/Volumes/Music', chosen: true })
    expect(await folder.current()).toEqual({ path: '/Volumes/Music', chosen: true })
  })

  it('says why it can’t', async () => {
    const plugin = fakePlugin()
    const folder = createDesktopDownloadsFolder({ bindings: plugin.bindings })
    plugin.failNext(DOWNLOAD_COMMANDS.chooseFolder, refusal('not-focused', 'Not in front'))
    const error = await folder.choose().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopCommandError)
    expect(error).toMatchObject({ code: 'not-focused', message: 'Not in front' })
    plugin.setFolder(undefined)
    await expect(folder.current()).rejects.toMatchObject({ code: 'no-folder' })
  })
})

describe('Save to device in the desktop app', () => {
  it('saves a copy into the downloads folder under its own name, without asking', async () => {
    const plugin = fakePlugin()
    const saver = createDesktopDeviceSaver({ bindings: plugin.bindings })
    const target = await saver.choose({ fileName: 'Radiohead - Creep.mp3', mimeType: 'audio/mpeg' })
    expect(target?.fileName).toBe('Radiohead - Creep.mp3')
    const content = testBytes(DOWNLOAD_WRITE_BYTES + 10)
    await target?.write(new Blob([content], { type: 'audio/mpeg' }))
    expect(plugin.callsOf(DOWNLOAD_COMMANDS.saveWrite)).toHaveLength(2)
    const saved = plugin.saved.get('Radiohead - Creep.mp3') ?? new Uint8Array(0)
    expect(saved.length).toBe(content.length)
    expect(content.every((byte, index) => saved[index] === byte)).toBe(true)
    await expect(target?.write(new Blob([bytes(1)]))).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
    // A second copy of the same name gets a number.
    const second = await saver.choose({ fileName: 'Radiohead - Creep.mp3', mimeType: 'audio/mpeg' })
    expect(second?.fileName).toBe('Radiohead - Creep (2).mp3')
    await second?.discard()
    expect(plugin.saves.size).toBe(0)
    expect([...plugin.saved.keys()]).toEqual(['Radiohead - Creep.mp3'])
  })

  it('gives the copy up when writing it fails', async () => {
    const plugin = fakePlugin()
    const saver = createDesktopDeviceSaver({ bindings: plugin.bindings })
    const target = await saver.choose({ fileName: 'Song.flac', mimeType: 'audio/flac' })
    plugin.failNext(DOWNLOAD_COMMANDS.saveWrite, refusal('storage-full'))
    const error = await target?.write(new Blob([bytes(1, 2)])).catch((e: unknown) => e)
    expect(isStorageFullError(error)).toBe(true)
    expect(plugin.saves.size).toBe(0)
    expect(plugin.saved.size).toBe(0)
  })
})
