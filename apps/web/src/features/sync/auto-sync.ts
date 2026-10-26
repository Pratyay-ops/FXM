/**
 * Automatic sync: a scheduler (see `scheduler.ts`) fed by the browser's events. The agent
 * (`agent.tsx`) loads this module only while sync is on, so the app's first load doesn't carry
 * the sync code.
 *
 * @module
 */

import { Dexie, type ObservabilitySet } from 'dexie'
import { DB_NAME } from '../../db/types'
import { useSettingsStore } from '../settings/settings-store'
import { runResult, runSync, schedulerOptions } from './controller'
import type { SyncReport } from './engine'
import { nameBeforeCopy } from './merge'
import { stoppedMessage } from './messages'
import { type ChangeKind, createSyncScheduler } from './scheduler'
import { needsUser } from './sync-store'

/** How often a visible app checks the gist for changes from other devices. */
export const SYNC_INTERVAL_MS = 15 * 60_000

/** Library tables whose changes the user made, which sync soon. */
const EDIT_TABLES = new Set(['likes', 'playlists', 'orders', 'follows', 'settings'])
/** Library tables that change in the background (plays, metadata, pins), which sync later. */
const BACKGROUND_TABLES = new Set(['history', 'tracks', 'matchCache'])

/** Which kind of synced change a database change is, if any. */
export function changeKindOf(parts: ObservabilitySet): ChangeKind | undefined {
  let kind: ChangeKind | undefined
  for (const part of Object.keys(parts)) {
    // `idb://<database>/<table>/<index>`
    const [database, table] = part.replace(/^idb:\/\//, '').split('/')
    if (database !== DB_NAME || table === undefined) continue
    if (EDIT_TABLES.has(table)) return 'edit'
    if (BACKGROUND_TABLES.has(table)) kind = 'background'
  }
  return kind
}

/** What to tell the user about a sync that ran by itself, if anything. */
export function reportMessage(report: SyncReport): string | undefined {
  const { copies, notices } = report
  if (copies.length === 1) {
    return `Sync kept two versions of “${nameBeforeCopy(copies[0]?.name ?? '')}”.`
  }
  if (copies.length > 1) return `Sync kept two versions of ${copies.length} playlists.`
  if (notices.length > 0) return 'Sync kept a playlist that one device had deleted.'
  return undefined
}

/**
 * Starts automatic sync: at once, when the user comes back, when the device is back online,
 * after changes to the library or the synced app settings, and periodically while the app is
 * visible. `onMessage` hears what a sync kept for the user to review, and why it stopped when
 * only the user can fix it. Returns the function that stops it.
 */
export function startAutoSync(onMessage: (text: string) => void): () => void {
  const options = schedulerOptions()
  const scheduler = createSyncScheduler({
    ...options,
    run: async (trigger) => {
      const run = await runSync(trigger)
      if (run.kind === 'synced') {
        const text = reportMessage(run.report)
        if (text !== undefined) onMessage(text)
      } else if (run.kind === 'failed' && needsUser(run.error.code)) {
        onMessage(stoppedMessage(run.error))
      }
      return runResult(run)
    },
  })
  const visible = () => document.visibilityState === 'visible'
  const onFocus = () => scheduler.trigger('focus')
  const onVisibility = () => {
    if (visible()) scheduler.trigger('focus')
  }
  const onOnline = () => scheduler.online()
  const onMutated = (parts: ObservabilitySet) => {
    const kind = changeKindOf(parts)
    if (kind !== undefined) scheduler.changed(kind)
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibility)
  Dexie.on('storagemutated', onMutated)
  // The app settings sync carries live in their own store, not in the library database. A
  // change a sync applied syncs nothing more: the library then still matches the gist.
  const stopSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.catalogMode !== previous.catalogMode || state.theme !== previous.theme) {
      scheduler.changed('edit')
    }
  })
  const interval = setInterval(() => {
    if (visible()) scheduler.trigger('interval')
  }, options.intervalMs ?? SYNC_INTERVAL_MS)
  scheduler.trigger('start')
  return () => {
    scheduler.stop()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibility)
    Dexie.on.storagemutated.unsubscribe(onMutated)
    stopSettings()
    clearInterval(interval)
  }
}
