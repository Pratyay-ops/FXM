/**
 * The OPFS worker: writes download files through sync access handles, which browsers offer only
 * in dedicated workers. The page talks to it through `storage.ts`; the work is in `handler.ts`.
 *
 * @module
 */

import { createOpfsHandler } from './handler'
import {
  type DirectoryHandleLike,
  DOWNLOADS_FOLDER,
  type OpfsAnswer,
  type OpfsMessage,
} from './protocol'

/** The worker's global scope, typed by hand: the app's TypeScript program has the DOM library. */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<OpfsMessage>) => void) | null
  postMessage(message: OpfsAnswer): void
  navigator: { storage: { getDirectory(): Promise<DirectoryHandleLike> } }
}

let folder: Promise<DirectoryHandleLike> | undefined

/** Whether this browser has sync access handles (Safari before 17 may not). */
function canSyncAccess(): boolean {
  const handle = (globalThis as { FileSystemFileHandle?: { prototype?: object } })
    .FileSystemFileHandle
  return typeof handle?.prototype === 'object' && 'createSyncAccessHandle' in handle.prototype
}

const handle = createOpfsHandler(
  () => {
    folder ??= scope.navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(DOWNLOADS_FOLDER, { create: true }))
    // A failure (a private window) may pass: try again next time.
    folder.catch(() => {
      folder = undefined
    })
    return folder
  },
  { canSyncAccess },
)

scope.onmessage = (event) => {
  const { id, request } = event.data
  handle(request).then(
    (value) =>
      scope.postMessage({ id, reply: value === undefined ? { ok: true } : { ok: true, value } }),
    (error: unknown) => {
      const name = error instanceof Error ? error.name : 'Error'
      const message = error instanceof Error ? error.message : String(error)
      scope.postMessage({ id, reply: { ok: false, name, message } })
    },
  )
}
