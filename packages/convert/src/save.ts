/**
 * "Save to device": putting a file where the user keeps files. A small interface, so that each
 * platform saves its own way: the browser through its file picker or its downloads, the desktop
 * app (stage 7.4) through a native save dialog, the Android app (stage 6.4) into the device's
 * music library.
 *
 * Saving takes two steps, because converting takes time. `choose` runs straight from the click,
 * while the browser still lets a page open its file picker, and only after the conversion does
 * the file go to the place chosen (`write`). Several files (an album) go into one folder the
 * user picks once (`chooseFolder`), where the platform has a folder picker.
 *
 * @module
 */

/** What is about to be saved. */
export interface SaveRequest {
  /** The suggested file name, with its extension. */
  readonly fileName: string
  readonly mimeType: string
  /** The kind of file, for the picker's type list, e.g. "FLAC audio". */
  readonly description?: string
}

/** Where a file will go, once it is ready. */
export interface SaveTarget {
  /** The name the file will get (the user may have changed it in a picker). */
  readonly fileName: string
  /** Writes the file there. Rejects when the place refuses it; nothing half-written stays. */
  write(blob: Blob): Promise<void>
  /**
   * Gives the place up without writing, e.g. after a failed or cancelled conversion, removing
   * whatever choosing it left behind (an empty file a picker created). Never rejects.
   */
  discard(): Promise<void>
}

/** What a folder for several files is asked for with. */
export interface FolderRequest {
  /**
   * Which folder the picker starts in, and remembers apart from other pickers: an ID of up to 32
   * letters, digits, `-` and `_`.
   */
  readonly id?: string
}

/**
 * A folder the user picked for several files (an album, a playlist): each file gets a target of
 * its own there, under its own name.
 */
export interface SaveFolder {
  /** The folder's name, for messages: "Music". */
  readonly name: string
  /**
   * A target for one file in the folder. The file is created only when it is written, under the
   * name asked for or, when the folder has a file of that name already, "Name (2).ext" and so
   * on: a file that is there is never replaced. Its `fileName` is the name it got once written.
   */
  target(request: SaveRequest): SaveTarget
}

/** Saves files on this device. */
export interface DeviceSaver {
  /**
   * Asks where to save, where the platform asks at all. Call it straight from the click.
   * Resolves with the target, or `undefined` when the user cancelled. It may reject (a native
   * dialog that fails): the app then reports the save as failed, saying the file couldn't be
   * written there, and nothing is converted.
   */
  choose(request: SaveRequest): Promise<SaveTarget | undefined>
  /**
   * Whether {@link choose} shows a picker that the browser opens only straight from a click (the
   * File System Access API's). Where it doesn't (the browser's downloads, a native dialog),
   * `choose` may run at any time, e.g. once a download has finished. Default: `false`.
   */
  asksWhere?(): boolean
  /**
   * Asks for a folder to save several files in, where the platform has a folder picker (Chromium
   * on desktop). Call it straight from the click. Resolves with the folder, `undefined` when the
   * user cancelled, or `null` where there is no folder to pick: save each file with
   * {@link choose} then (the browser's downloads).
   */
  chooseFolder?(request?: FolderRequest): Promise<SaveFolder | null | undefined>
}

/** What FXM uses of a `FileSystemWritableFileStream`. */
interface PickedFileWriter {
  write(data: Blob): Promise<void>
  close(): Promise<void>
  /** Drops what was written; the file keeps what it had. */
  abort?(): Promise<void>
}

/** What FXM uses of the `FileSystemFileHandle` a save picker returns. */
interface PickedFile {
  readonly name: string
  createWritable(): Promise<PickedFileWriter>
  /** The file as it is now. */
  getFile?(): Promise<{ readonly size: number }>
  /** Removes the file (Chromium 110 and later). */
  remove?(): Promise<void>
}

/** The File System Access API's save picker, where the browser has it (Chromium on desktop). */
interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<PickedFile>
}

/** What FXM uses of the `FileSystemDirectoryHandle` a folder picker returns. */
interface PickedFolder {
  readonly name: string
  /** The file `name` in the folder; with `create`, created empty when it isn't there. */
  getFileHandle(name: string, options?: { create?: boolean }): Promise<PickedFile>
  /** Removes the entry `name` from the folder. */
  removeEntry?(name: string): Promise<void>
}

/** The File System Access API's folder picker, where the browser has it (Chromium on desktop). */
interface FolderPickerWindow {
  showDirectoryPicker?: (options: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string
  }) => Promise<PickedFolder>
}

/** What {@link createBrowserDeviceSaver} uses; tests pass fakes. */
export interface BrowserSaverEnvironment {
  readonly window?: SavePickerWindow & FolderPickerWindow
  readonly document?: Pick<Document, 'createElement' | 'body'>
  readonly createObjectURL?: (blob: Blob) => string
  readonly revokeObjectURL?: (url: string) => void
}

/** How long a download link's object URL lives: long enough for every browser to start. */
const LINK_LIFETIME_MS = 60_000

/** A target that downloads the file through a temporary link, as browsers save downloads. */
function linkTarget(fileName: string, environment: BrowserSaverEnvironment): SaveTarget {
  return {
    fileName,
    async write(blob) {
      const document = environment.document ?? globalThis.document
      const create = environment.createObjectURL ?? ((value: Blob) => URL.createObjectURL(value))
      const revoke = environment.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))
      const url = create(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => revoke(url), LINK_LIFETIME_MS)
    },
    async discard() {},
  }
}

/**
 * A target that writes to the file the user picked. Chromium creates that file, empty, as the
 * picker closes (and may empty a file the user chose to replace), so giving the target up
 * removes it while it is still empty: a failed or cancelled save leaves no empty
 * "Artist - Title.flac" behind, and a file with content in it is never removed.
 */
function pickedFileTarget(handle: PickedFile): SaveTarget {
  return {
    fileName: handle.name,
    async write(blob) {
      const writer = await handle.createWritable()
      try {
        await writer.write(blob)
        await writer.close()
      } catch (error) {
        // The browser writes to a temporary copy until close(): drop it.
        await writer.abort?.().catch(() => undefined)
        throw error
      }
    },
    async discard() {
      try {
        if (handle.getFile === undefined || handle.remove === undefined) return
        if ((await handle.getFile()).size === 0) await handle.remove()
      } catch {
        // Gone already, or the browser refuses: nothing more to do.
      }
    },
  }
}

/** Whether `error` is the user closing a picker. */
function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Whether `error` says a file isn't there. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError'
}

/** "Name (2).ext" for the second file called "Name.ext", and so on. */
export function numberedFileName(fileName: string, n: number): string {
  if (n <= 1) return fileName
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''
  return `${stem} (${n})${extension}`
}

/** How many numbered names a folder target tries before it gives up. */
const MAX_NUMBERED_NAMES = 1000

/**
 * A target for a new file in a picked folder. The file is created when it is written, under the
 * first name the folder has no file of, so a file that is there is never replaced; a write that
 * fails removes the file it created while that is still empty.
 */
function folderFileTarget(folder: PickedFolder, request: SaveRequest): SaveTarget {
  let fileName = request.fileName
  let created: PickedFile | undefined
  const discard = async () => {
    const file = created
    created = undefined
    if (file === undefined) return
    try {
      if (file.getFile !== undefined && (await file.getFile()).size !== 0) return
      if (folder.removeEntry !== undefined) await folder.removeEntry(fileName)
      else await file.remove?.()
    } catch {
      // Gone already, or the browser refuses: nothing more to do.
    }
  }
  return {
    get fileName() {
      return fileName
    },
    async write(blob) {
      for (let n = 1; created === undefined; n++) {
        if (n > MAX_NUMBERED_NAMES) throw new Error(`No free name for ${request.fileName}`)
        const candidate = numberedFileName(request.fileName, n)
        try {
          await folder.getFileHandle(candidate)
          continue // Taken: try the next number.
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
        created = await folder.getFileHandle(candidate, { create: true })
        fileName = candidate
      }
      await pickedFileTarget(created)
        .write(blob)
        .catch(async (error: unknown) => {
          await discard()
          throw error
        })
      created = undefined
    },
    discard,
  }
}

/**
 * The browser's way of saving: the save picker where the browser has one (the user picks the
 * folder and the name), otherwise a download, which lands in the browser's downloads folder or
 * asks, as the user set it up. For several files, the folder picker where the browser has one
 * (the user picks a folder once and grants FXM write access to it), otherwise a download each.
 */
export function createBrowserDeviceSaver(environment: BrowserSaverEnvironment = {}): DeviceSaver {
  const host = () => environment.window ?? (globalThis as SavePickerWindow & FolderPickerWindow)
  return {
    asksWhere: () => typeof host().showSaveFilePicker === 'function',
    async chooseFolder(request = {}) {
      const browser = host()
      if (typeof browser.showDirectoryPicker !== 'function') return null
      try {
        // Called on its window, as the save picker. Write access is asked for as the folder is
        // picked, in the same prompt.
        const folder = await browser.showDirectoryPicker({
          ...(request.id === undefined ? {} : { id: request.id }),
          mode: 'readwrite',
          startIn: 'music',
        })
        return {
          name: folder.name,
          target: (file) => folderFileTarget(folder, file),
        }
      } catch (error) {
        if (isCancel(error)) return undefined
        // No user activation left, or a folder picker the browser refuses here.
        return null
      }
    },
    async choose(request) {
      const browser = host()
      if (typeof browser.showSaveFilePicker !== 'function') {
        return linkTarget(request.fileName, environment)
      }
      const extension = /\.[A-Za-z0-9]+$/.exec(request.fileName)?.[0]
      try {
        // Called on its window: a detached call throws "Illegal invocation".
        const handle = await browser.showSaveFilePicker({
          suggestedName: request.fileName,
          ...(extension === undefined
            ? {}
            : {
                types: [
                  {
                    ...(request.description === undefined
                      ? {}
                      : { description: request.description }),
                    accept: { [request.mimeType]: [extension] },
                  },
                ],
              }),
        })
        return pickedFileTarget(handle)
      } catch (error) {
        if (isCancel(error)) return undefined
        // No user activation left, or a picker the browser refuses here: download instead.
        return linkTarget(request.fileName, environment)
      }
    },
  }
}
