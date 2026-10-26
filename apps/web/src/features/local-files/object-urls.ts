/**
 * Object URLs for local files: the `blob:` URLs the audio element plays them from.
 *
 * An object URL of a file costs next to nothing (the browser reads the file on disk, it doesn't
 * copy it), but each one lives until it is revoked or the page closes. This cache keeps the
 * most recent few, enough for the track playing, the one after it that the player preloads and
 * a few the playback policy prefetches, and revokes older ones. A URL revoked while still in use
 * fails like any broken stream, and the player resolves the track again.
 *
 * @module
 */

/** How many object URLs stay alive. */
export const OBJECT_URL_CAPACITY = 16

/** Creates and revokes object URLs; tests pass fakes. */
export interface ObjectUrlApi {
  create(blob: Blob): string
  revoke(url: string): void
}

const browserApi: ObjectUrlApi = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

/** A cache of object URLs by key, oldest revoked first. */
export class ObjectUrlCache {
  readonly #urls = new Map<string, string>()
  readonly #capacity: number
  readonly #api: ObjectUrlApi

  constructor(capacity = OBJECT_URL_CAPACITY, api: ObjectUrlApi = browserApi) {
    this.#capacity = Math.max(1, capacity)
    this.#api = api
  }

  /**
   * The object URL for `key`, made from `blob` the first time. Use a key that changes when the
   * file does (its path, size and modification time), so an edited file gets a fresh URL.
   */
  urlFor(key: string, blob: Blob): string {
    const existing = this.#urls.get(key)
    if (existing !== undefined) {
      // Most recently used goes last.
      this.#urls.delete(key)
      this.#urls.set(key, existing)
      return existing
    }
    const url = this.#api.create(blob)
    this.#urls.set(key, url)
    while (this.#urls.size > this.#capacity) {
      const [oldestKey, oldestUrl] = this.#urls.entries().next().value as [string, string]
      this.#urls.delete(oldestKey)
      this.#api.revoke(oldestUrl)
    }
    return url
  }

  /** How many URLs are alive. */
  get size(): number {
    return this.#urls.size
  }

  /** Revokes every URL. */
  clear(): void {
    for (const url of this.#urls.values()) this.#api.revoke(url)
    this.#urls.clear()
  }
}
