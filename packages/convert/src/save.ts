/**
 * "Save to device": putting a file where the user keeps files. A small interface, so that each
 * platform saves its own way: the browser through its file picker or its downloads, the desktop
 * app (stage 7.4) into its downloads folder without a dialog, the Android app into the device's
 * music library (neither is wired in yet: stage 6.4's "Save to Music folder" copies a download
 * as it is).
 *
 * Saving takes two steps, because converting takes time. `choose` runs straight from the click,
 * while the browser still lets a page open its file picker, and only after the conversion does
 * the file go to the place chosen (`write`).
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

/** Saves files on this device. */
export interface DeviceSaver {
  /**
   * Asks where to save, where the platform asks at all. Call it straight from the click.
   * Resolves with the target, or `undefined` when the user cancelled. It may reject (a native
   * dialog that fails): the app then reports the save as failed, saying the file couldn't be
   * written there, and nothing is converted.
   */
  choose(request: SaveRequest): Promise<SaveTarget | undefined>
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

/** What {@link createBrowserDeviceSaver} uses; tests pass fakes. */
export interface BrowserSaverEnvironment {
  readonly window?: SavePickerWindow
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

/**
 * The browser's way of saving: the save picker where the browser has one (the user picks the
 * folder and the name), otherwise a download, which lands in the browser's downloads folder or
 * asks, as the user set it up.
 */
export function createBrowserDeviceSaver(environment: BrowserSaverEnvironment = {}): DeviceSaver {
  return {
    async choose(request) {
      const host = environment.window ?? (globalThis as SavePickerWindow)
      if (typeof host.showSaveFilePicker !== 'function') {
        return linkTarget(request.fileName, environment)
      }
      const extension = /\.[A-Za-z0-9]+$/.exec(request.fileName)?.[0]
      try {
        // Called on its window: a detached call throws "Illegal invocation".
        const handle = await host.showSaveFilePicker({
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
