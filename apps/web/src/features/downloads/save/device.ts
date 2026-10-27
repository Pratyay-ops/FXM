/**
 * Whether FXM can save files on this device, and how: the light part of Save to device, which
 * menus and Settings read without loading the converter.
 *
 * - **In a browser** (the web app), always: the browser's save picker where it has one (Chromium
 *   on desktop), otherwise its downloads.
 * - **In the desktop and Android apps**, only once they hand the web app a saver of their own
 *   ({@link setDeviceSaver}: a native save dialog, the device's music library). Their web views
 *   have no download handling of their own, so a browser download there would vanish while FXM
 *   said "Saved".
 *
 * @module
 */

import type { DeviceSaver } from '@fxm/convert'
import type { Platform } from '@fxm/core'
import { useSyncExternalStore } from 'react'
import { useConnection } from '../../connect/connection'

let nativeSaver: DeviceSaver | undefined
const listeners = new Set<() => void>()

/** The saver the desktop or Android app set (or a test), if any. */
export function nativeDeviceSaver(): DeviceSaver | undefined {
  return nativeSaver
}

/**
 * Replaces the device saver: the desktop and Android apps save their own way (stages 7.4 and
 * 6.4); tests pass fakes. `undefined` goes back to the browser's.
 */
export function setDeviceSaver(next: DeviceSaver | undefined): void {
  if (next === nativeSaver) return
  nativeSaver = next
  for (const listener of [...listeners]) listener()
}

/**
 * Where a saved file goes here:
 *
 * - `picker`: where the user picks, in the browser's save picker (Chromium on desktop);
 * - `downloads`: the browser's downloads;
 * - `app`: wherever the desktop or Android app's own saver puts it;
 * - `none`: nowhere, since this app has no saver yet (the desktop and Android apps until they
 *   set one).
 */
export type SaveDestination = 'picker' | 'downloads' | 'app' | 'none'

/** Where a saved file goes on `platform` (see {@link SaveDestination}). */
export function saveDestination(
  platform: Platform = useConnection.getState().platform,
): SaveDestination {
  if (nativeSaver !== undefined) return 'app'
  if (platform !== 'web') return 'none'
  const picker = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
  return typeof picker === 'function' ? 'picker' : 'downloads'
}

/**
 * Whether several files can go into one folder the user picks once: the app's saver says so with
 * its `chooseFolder`, a browser with its folder picker (Chromium on desktop).
 */
export function canPickFolder(): boolean {
  if (nativeSaver !== undefined) return typeof nativeSaver.chooseFolder === 'function'
  const picker = (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker
  return typeof picker === 'function'
}

/** Whether FXM can save files on this device at all. */
export function fileSavingAvailable(platform?: Platform): boolean {
  return saveDestination(platform) !== 'none'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link saveDestination}, kept current as the platform and the saver change. */
export function useSaveDestination(): SaveDestination {
  const platform = useConnection((state) => state.platform)
  // A saver set later (the native apps set theirs as they start) re-renders the readers.
  useSyncExternalStore(subscribe, nativeDeviceSaver, nativeDeviceSaver)
  return saveDestination(platform)
}
