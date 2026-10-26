/**
 * The desktop app's network monitor for the stream lifecycle's URL cache (stage 7.3).
 *
 * YouTube's stream URLs work only from the IP address that resolved them, so the lifecycle keys
 * its cache by network and flushes it on every change. In the desktop app a change is:
 *
 * - the shell's native notification (`src-tauri/src/network.rs`), which watches the route the
 *   operating system would send internet traffic on: a new Wi-Fi network, a cable, a VPN, a new
 *   temporary IPv6 address;
 * - the webview's `online` and `offline` events.
 *
 * Unlike the browser monitor, it ignores the Network Information API, which only Chromium has
 * and whose estimates change on their own every few minutes. The desktop never reports
 * cellular data: a computer can't tell a phone's hotspot from Wi-Fi.
 *
 * @module
 */

import type { DisposableNetworkMonitor } from '@fxm/player'
import type { DesktopShell } from './shell'

/** Options for {@link createDesktopNetworkMonitor}. */
export interface DesktopNetworkMonitorOptions {
  /** The desktop shell, whose native network notifications count as changes. */
  shell: Pick<DesktopShell, 'onNetworkChange'>
  /** Where `online` and `offline` fire. Default: the page (`globalThis`). */
  target?: EventTarget
}

/** Calls each listener, reporting rather than throwing an error one raises. */
function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error(error)
    }
  }
}

/** Creates the desktop app's {@link DisposableNetworkMonitor} (see the module documentation). */
export function createDesktopNetworkMonitor(
  options: DesktopNetworkMonitorOptions,
): DisposableNetworkMonitor {
  const target = options.target ?? globalThis
  const listeners = new Set<() => void>()
  const stop = new AbortController()
  let generation = 0
  const changed = () => {
    generation += 1
    notify(listeners)
  }
  target.addEventListener('online', changed, { signal: stop.signal })
  target.addEventListener('offline', changed, { signal: stop.signal })
  const stopNative = options.shell.onNetworkChange(changed)
  return {
    get id() {
      return `desktop-network-${generation}`
    },
    cellular: false,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    destroy() {
      stop.abort()
      stopNative()
      listeners.clear()
    },
  }
}
