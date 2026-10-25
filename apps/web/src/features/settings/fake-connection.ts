/**
 * A stand-in for the Network Information API (`navigator.connection`) in tests: the browsers
 * that report a connection type are Chromium on Android and ChromeOS, and happy-dom isn't one.
 *
 * @module
 */

import type { NetworkInformationLike } from './use-connection'

/** A `navigator.connection` whose type a test changes. */
export class FakeConnection extends EventTarget implements NetworkInformationLike {
  type: unknown

  constructor(type?: unknown) {
    super()
    this.type = type
  }

  /** Moves to another connection type and fires `change`, as the browser does. */
  change(type: unknown): void {
    this.type = type
    this.dispatchEvent(new Event('change'))
  }
}

/** Gives `navigator` a connection (or takes it away with `undefined`) until {@link removeConnection}. */
export function installConnection(connection: NetworkInformationLike | undefined): void {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: connection })
}

/** Removes the connection {@link installConnection} gave `navigator`. */
export function removeConnection(): void {
  Reflect.deleteProperty(navigator, 'connection')
}
