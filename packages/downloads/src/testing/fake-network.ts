/**
 * A network a test switches on and off.
 *
 * @module
 */

import type { DownloadNetwork } from '../manager'

/** A {@link DownloadNetwork} that is online until a test says otherwise. */
export class FakeNetwork implements DownloadNetwork {
  #online = true
  readonly #listeners = new Set<() => void>()

  /** Whether the device is online. */
  get online(): boolean {
    return this.#online
  }

  /** Goes online or offline, telling the listeners when that changes. */
  set(online: boolean): void {
    if (online === this.#online) return
    this.#online = online
    for (const listener of [...this.#listeners]) listener()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
