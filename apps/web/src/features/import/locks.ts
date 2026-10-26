/**
 * One tab at a time per import: a Web Lock (`navigator.locks`) named after the import is held
 * while a tab runs it, records its listening history or writes a review decision, so two tabs
 * never run the same import or overwrite each other's progress. Other tabs see the lock and show
 * the import as running elsewhere.
 *
 * Browsers without Web Locks (and tests, unless they pass a fake) run everything: each tab then
 * guards only its own work.
 *
 * @module
 */

/** What imports use of the Web Locks API (`LockManager`). */
export interface ImportLockManager {
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
  query(): Promise<{ held?: readonly { name?: string }[] }>
}

/** How long a tab waits for an import's lock before it takes the import as running elsewhere. */
export const LOCK_WAIT_MS = 2000

let lockWaitMs = LOCK_WAIT_MS

const PREFIX = 'fxm-import:'

let override: ImportLockManager | null | undefined

/** The imports whose lock this tab holds now, by how many of its calls hold it. */
const own = new Map<string, number>()

/**
 * Tests: use `manager` instead of the browser's (`null`: none; `undefined`: the browser's
 * again), waiting `waitMs` for a lock instead of {@link LOCK_WAIT_MS}.
 */
export function setImportLockManager(
  manager: ImportLockManager | null | undefined,
  waitMs = LOCK_WAIT_MS,
): void {
  override = manager
  lockWaitMs = waitMs
}

function lockManager(): ImportLockManager | null {
  if (override !== undefined) return override
  const locks = (globalThis.navigator as { locks?: ImportLockManager | null } | undefined)?.locks
  return locks ?? null
}

/** The lock's name for import `id`. */
export function importLockName(id: string): string {
  return `${PREFIX}${id}`
}

/** Thrown when another tab holds an import's lock. */
export class ImportBusyError extends Error {
  override readonly name = 'ImportBusyError'

  constructor() {
    super('This import is running in another tab or window.')
  }
}

/**
 * Runs `body` holding import `id`'s lock, waiting up to {@link LOCK_WAIT_MS} for it (another
 * tab's review decision takes a moment). Without Web Locks it just runs `body`.
 *
 * @throws ImportBusyError when another tab keeps the lock: it is running the import.
 */
export async function withImportLock<T>(id: string, body: () => Promise<T>): Promise<T> {
  const locks = lockManager()
  if (locks === null) return body()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), lockWaitMs)
  try {
    return await locks.request(importLockName(id), { signal: timeout.signal }, async () => {
      clearTimeout(timer)
      own.set(id, (own.get(id) ?? 0) + 1)
      try {
        return await body()
      } finally {
        const left = (own.get(id) ?? 1) - 1
        if (left > 0) own.set(id, left)
        else own.delete(id)
      }
    })
  } catch (error) {
    if (timeout.signal.aborted && (error as { name?: string } | null)?.name === 'AbortError') {
      throw new ImportBusyError()
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The imports whose lock another tab holds now: it runs them, records their history or saves a
 * review decision. Empty without Web Locks.
 */
export async function importsHeldElsewhere(): Promise<Set<string>> {
  const locks = lockManager()
  if (locks === null) return new Set()
  const { held = [] } = await locks.query()
  const ids = new Set<string>()
  for (const lock of held) {
    if (!lock.name?.startsWith(PREFIX)) continue
    const id = lock.name.slice(PREFIX.length)
    if (!own.has(id)) ids.add(id)
  }
  return ids
}

/** Tests: forgets which locks this tab holds. */
export function resetImportLocks(): void {
  own.clear()
}
