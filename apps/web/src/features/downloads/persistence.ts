/**
 * The browser's storage settings for downloads: how much room there is (the usage meter), and
 * whether the browser keeps FXM's data when the device runs low on space
 * (`navigator.storage.persist()`).
 *
 * Browsers that don't offer these report `undefined`, and the UI leaves that part out.
 *
 * @module
 */

/** How much space FXM uses, and how much this browser lets it use. */
export interface StorageEstimate {
  /** Bytes FXM uses in all: downloads, the library, caches. */
  usage: number
  /** Bytes this browser lets FXM use at most. */
  quota: number
}

function storageManager(): StorageManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage
}

/** How much space FXM uses and may use, or `undefined` when the browser doesn't say. */
export async function estimateStorage(): Promise<StorageEstimate | undefined> {
  const manager = storageManager()
  if (typeof manager?.estimate !== 'function') return undefined
  try {
    const { usage, quota } = await manager.estimate()
    if (usage === undefined || quota === undefined) return undefined
    return { usage, quota }
  } catch {
    return undefined
  }
}

/**
 * Whether the browser keeps FXM's data when space runs low, or `undefined` when it doesn't
 * say.
 */
export async function isStoragePersisted(): Promise<boolean | undefined> {
  const manager = storageManager()
  if (typeof manager?.persisted !== 'function') return undefined
  try {
    return await manager.persisted()
  } catch {
    return undefined
  }
}

/**
 * Asks the browser to keep FXM's data when space runs low. Call it straight from a click:
 * Firefox asks the user, Chromium decides by itself (an installed app, a bookmark and frequent
 * use help). Resolves with the answer, or `undefined` when the browser has no such setting.
 */
export function requestStoragePersistence(): Promise<boolean | undefined> {
  const manager = storageManager()
  if (typeof manager?.persist !== 'function') return Promise.resolve(undefined)
  try {
    return manager.persist().catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}
