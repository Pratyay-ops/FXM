/**
 * Which network the device is on, as far as the stream lifecycle cares: YouTube's stream URLs
 * are bound to the IP address that resolved them, so the URL cache is kept per network and
 * flushed whenever the network changes.
 *
 * @module
 */

/**
 * The current network and its changes. The lifecycle keys its URL cache by {@link id} and
 * flushes it on every change.
 */
export interface NetworkMonitor {
  /**
   * An opaque ID of the current network. It changes on every `online`, `offline` and
   * connection-change event, so URLs resolved before a change are never handed out after it.
   */
  readonly id: string
  /**
   * Whether the device is on mobile data, when the platform can tell. Playback then streams at
   * the cellular quality ceiling and prefers audio only to a muxed video.
   */
  readonly cellular: boolean
  /** Calls `listener` after every change. Returns a function that stops it. */
  subscribe(listener: () => void): () => void
}

/** A {@link NetworkMonitor} that can be shut down. */
export interface DisposableNetworkMonitor extends NetworkMonitor {
  /** Stops listening to the platform's events. */
  destroy(): void
}

/** The parts of the Network Information API (`navigator.connection`, Chromium only) it reads. */
export interface ConnectionLike extends EventTarget {
  /**
   * The connection type, e.g. `wifi` or `cellular`. Chrome has it on Android and ChromeOS only;
   * desktop Chrome and Edge leave it out (MDN's compatibility data, checked 2026-10-26).
   */
  readonly type?: string
}

/** Options for {@link createBrowserNetworkMonitor}. */
export interface BrowserNetworkMonitorOptions {
  /** Where `online` and `offline` fire. Default: `window`. */
  target?: EventTarget
  /**
   * The Network Information API, whose `change` event fires when the connection `type` changes,
   * and also when only its estimates (`downlink`, `rtt`) move (the WICG specification, checked
   * 2026-10-26). Default: `navigator.connection` where the browser has one (Chromium); `null`
   * for none.
   */
  connection?: ConnectionLike | null
}

function defaultConnection(): ConnectionLike | null {
  if (typeof navigator === 'undefined') return null
  const { connection } = navigator as Navigator & { connection?: ConnectionLike }
  return connection ?? null
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

/**
 * A {@link NetworkMonitor} for browsers and webviews: the network changes on `online` and
 * `offline`, and on a Network Information API `change` event that changes the connection
 * `type` (Chromium on Android and ChromeOS). A `change` of the estimates alone is no new
 * network, and desktop Chromium, which has no `type`, changes network only on `online` and
 * `offline`; a 403 on a cached URL still flushes the cache there. Desktop and Android apps
 * report changes from native network callbacks instead (stages 7.3 and 6.3), behind the same
 * interface.
 */
export function createBrowserNetworkMonitor(
  options: BrowserNetworkMonitorOptions = {},
): DisposableNetworkMonitor {
  const target = options.target ?? globalThis
  const connection = options.connection === undefined ? defaultConnection() : options.connection
  const listeners = new Set<() => void>()
  const stop = new AbortController()
  let generation = 0
  let type = connection?.type
  const changed = () => {
    generation += 1
    type = connection?.type
    notify(listeners)
  }
  const connectionChanged = () => {
    if (connection?.type !== type) changed()
  }
  target.addEventListener('online', changed, { signal: stop.signal })
  target.addEventListener('offline', changed, { signal: stop.signal })
  connection?.addEventListener('change', connectionChanged, { signal: stop.signal })
  return {
    get id() {
      return `network-${generation}`
    },
    get cellular() {
      return connection?.type === 'cellular'
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    destroy() {
      stop.abort()
      listeners.clear()
    },
  }
}

/** A {@link NetworkMonitor} that never changes, for platforms that report no network events. */
export function createStaticNetworkMonitor(cellular = false): NetworkMonitor {
  return {
    id: 'network-0',
    cellular,
    subscribe: () => () => {},
  }
}
