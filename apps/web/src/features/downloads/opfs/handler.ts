/**
 * What the OPFS worker does with each request, apart from the worker itself so tests can run it
 * on a fake directory. It keeps one sync access handle per open file: writes land in the file
 * in place, and a flushed write survives a crash, so a download resumes where its file ends.
 *
 * @module
 */

import { assertSafeFileName } from '@fxm/downloads'
import type { DirectoryHandleLike, OpfsRequest, SyncAccessHandleLike } from './protocol'

function failure(name: string, message: string): Error {
  return new DOMException(message, name)
}

/** Options for {@link createOpfsHandler}. */
export interface OpfsHandlerOptions {
  /**
   * Whether this browser has sync access handles, for `probe`. The worker checks
   * `FileSystemFileHandle.prototype`; tests say. Default: yes.
   */
  canSyncAccess?: () => boolean
}

/**
 * A handler for the worker's requests over the folder `directory()` gives (the downloads folder
 * of the Origin Private File System). Resolves with the request's value (see `OpfsReply`), or
 * rejects with the file system's error, e.g. `QuotaExceededError` when the storage is full. A
 * file name `isSafeFileName` refuses is rejected before the file system sees it.
 */
export function createOpfsHandler(
  directory: () => Promise<DirectoryHandleLike>,
  options: OpfsHandlerOptions = {},
) {
  const handles = new Map<string, SyncAccessHandleLike>()
  const open = (file: string): SyncAccessHandleLike => {
    const handle = handles.get(file)
    if (handle === undefined) throw failure('InvalidStateError', `${file} is not open`)
    return handle
  }
  const release = async (file: string): Promise<void> => {
    const handle = handles.get(file)
    if (handle === undefined) return
    handles.delete(file)
    try {
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  return async function handle(request: OpfsRequest): Promise<number | undefined> {
    if (request.op === 'probe') {
      await directory()
      return (options.canSyncAccess?.() ?? true) ? 1 : 0
    }
    const { file } = request
    assertSafeFileName(file)
    switch (request.op) {
      case 'open': {
        if (handles.has(file))
          throw failure('NoModificationAllowedError', `${file} is already open`)
        const folder = await directory()
        const fileHandle = await folder.getFileHandle(file, { create: true })
        if (typeof fileHandle.createSyncAccessHandle !== 'function') {
          throw failure('NotSupportedError', 'This browser has no sync access handles')
        }
        const access = await fileHandle.createSyncAccessHandle()
        handles.set(file, access)
        return await access.getSize()
      }
      case 'size':
        return await open(file).getSize()
      case 'write': {
        const access = open(file)
        const bytes = new Uint8Array(request.data)
        let written = 0
        while (written < bytes.length) {
          const count = access.write(bytes.subarray(written), { at: request.offset + written })
          if (count <= 0) throw failure('QuotaExceededError', 'Nothing more could be written')
          written += count
        }
        return written
      }
      case 'truncate':
        await open(file).truncate(request.size)
        return undefined
      case 'flush':
        await open(file).flush()
        return undefined
      case 'close':
        await release(file)
        return undefined
      case 'remove': {
        // The worker holds every handle this tab opened: let go first, then delete.
        await release(file).catch(() => {})
        const folder = await directory()
        try {
          await folder.removeEntry(file)
        } catch (error) {
          if (!(error instanceof Error && error.name === 'NotFoundError')) throw error
        }
        return undefined
      }
    }
  }
}
