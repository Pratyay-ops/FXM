/**
 * A network monitor whose changes a test triggers.
 *
 * @module
 */

import type { NetworkMonitor } from '../network'

/** A {@link NetworkMonitor} that changes only when the test calls {@link FakeNetworkMonitor.change}. */
export class FakeNetworkMonitor implements NetworkMonitor {
  #generation = 0
  #cellular: boolean
  readonly #listeners = new Set<() => void>()

  constructor(cellular = false) {
    this.#cellular = cellular
  }

  get id(): string {
    return `fake-network-${this.#generation}`
  }

  get cellular(): boolean {
    return this.#cellular
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Moves to another network, e.g. from Wi-Fi to mobile data, and tells the listeners. */
  change(cellular = this.#cellular): void {
    this.#generation += 1
    this.#cellular = cellular
    for (const listener of [...this.#listeners]) listener()
  }
}
