/**
 * Starts scrobbling when the app starts, while loading nothing heavy: the scrobbler, its
 * clients and the IndexedDB queue (`scrobbling.ts`, with Dexie) load only once an account is
 * connected, at start or later from Settings. Until then this module only listens.
 *
 * It listens to the player's plays from the start, and hands them to the loaded scrobbling in
 * the order they came, so no play is lost while it loads.
 *
 * @module
 */

import { onPlays, type PlayListener } from '../signals/play-events'
import type { AppScrobbling } from './scrobbling'
import { hasAccounts, syncScrobblingAcrossTabs, useScrobblingStore } from './scrobbling-store'

/** Loads the app's scrobbling; tests pass their own. */
export type LoadScrobbling = () => Promise<{ runAppScrobbling: () => AppScrobbling }>

/**
 * Starts scrobbling for the app: call it once at start. It keeps the accounts in step with
 * other tabs and, once an account is connected, loads and runs the scrobbling and feeds it the
 * player's plays. Returns the function that stops it all.
 */
export function startScrobbling(load: LoadScrobbling = () => import('./scrobbling')): () => void {
  const stops: (() => void)[] = [syncScrobblingAcrossTabs()]
  let stopped = false
  let running: Promise<PlayListener> | undefined

  /** The running scrobbling's play listener, loading and running it the first time. */
  const run = (): Promise<PlayListener> => {
    running ??= load().then(
      (module) => {
        const app = module.runAppScrobbling()
        if (stopped) app.stop()
        else stops.push(app.stop)
        return app.listener
      },
      (error: unknown) => {
        // Loading failed (offline before the code was cached): try again next time.
        running = undefined
        throw error
      },
    )
    return running
  }

  const connected = () => hasAccounts(useScrobblingStore.getState())
  const deliver = (handle: (listener: PlayListener) => void) => {
    if (!connected()) return
    run()
      .then(handle)
      .catch((error: unknown) => console.error('Scrobbling could not start', error))
  }
  stops.push(
    onPlays({
      started: (play) => deliver((listener) => listener.started?.(play)),
      ended: (play) => deliver((listener) => listener.ended?.(play)),
    }),
  )

  // Run as soon as an account exists: now, or once the user connects one.
  const runWhenConnected = () => {
    if (stopped || !connected()) return
    run().catch((error: unknown) => console.error('Scrobbling could not start', error))
  }
  stops.push(useScrobblingStore.subscribe(runWhenConnected))
  runWhenConnected()

  return () => {
    stopped = true
    for (const stop of stops.reverse()) stop()
  }
}
