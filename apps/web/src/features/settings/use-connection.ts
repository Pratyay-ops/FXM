import { connectionFromType, type DetectedConnection } from '@fxm/core'
import { useSyncExternalStore } from 'react'

/**
 * The part of the Network Information API (`navigator.connection`) the quality settings read.
 * Every Chromium browser has the object, but only Chromium on Android and ChromeOS, and
 * Android's WebView (the Android app), fill in `type`.
 */
export interface NetworkInformationLike extends EventTarget {
  readonly type?: unknown
}

/** What the browser says about its connection. */
export interface ConnectionStatus {
  /** Whether the browser reports its connection type at all. */
  readonly supported: boolean
  /** The connection it reports; `unknown` when it reports none, or a type such as Bluetooth. */
  readonly detected: DetectedConnection
}

const UNSUPPORTED: ConnectionStatus = Object.freeze({ supported: false, detected: 'unknown' })

// One object per answer, so that useSyncExternalStore sees the same snapshot until it changes.
const SUPPORTED: Readonly<Record<DetectedConnection, ConnectionStatus>> = Object.freeze({
  wifi: Object.freeze({ supported: true, detected: 'wifi' }),
  cellular: Object.freeze({ supported: true, detected: 'cellular' }),
  unknown: Object.freeze({ supported: true, detected: 'unknown' }),
})

/** The browser's `navigator.connection`, where it has one. */
export function networkInformation(): NetworkInformationLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const { connection } = navigator as Navigator & { connection?: NetworkInformationLike | null }
  return connection ?? undefined
}

/** What `info` (by default the browser's `navigator.connection`) reports now. */
export function readConnection(info = networkInformation()): ConnectionStatus {
  const type = info?.type
  return typeof type === 'string' ? SUPPORTED[connectionFromType(type)] : UNSUPPORTED
}

function subscribe(onChange: () => void): () => void {
  const info = networkInformation()
  info?.addEventListener('change', onChange)
  return () => info?.removeEventListener('change', onChange)
}

const read = () => readConnection()
const readOnServer = () => UNSUPPORTED

/** The browser's connection, updated whenever it changes. */
export function useConnection(): ConnectionStatus {
  return useSyncExternalStore(subscribe, read, readOnServer)
}
