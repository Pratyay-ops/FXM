import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { type PwaStore, usePwaStore } from './pwa-store'

/** `registerSW` from `virtual:pwa-register`: main.tsx passes the real one, tests a fake. */
export type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

/** How often an open window asks the site for a new version: FXM can stay open for days. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000

/** The parts of a `ServiceWorkerRegistration` the update check uses. */
export type UpdatableRegistration = Pick<ServiceWorkerRegistration, 'installing' | 'update'>

/** The parts of a `ServiceWorkerRegistration` the update flow uses. */
export type AppRegistration = UpdatableRegistration & Pick<ServiceWorkerRegistration, 'waiting'>

/** The part of `navigator.serviceWorker` that reports a new worker taking over the page. */
export type ControllerEvents = Pick<
  ServiceWorkerContainer,
  'addEventListener' | 'removeEventListener'
>

export interface ServiceWorkerOptions {
  store?: PwaStore
  /** Time between update checks. Default: {@link UPDATE_CHECK_INTERVAL_MS}. */
  checkIntervalMs?: number
  /** Whether the device is online. Default: `navigator.onLine`. */
  isOnline?: () => boolean
  /** Reloads the page. Default: `location.reload()`. */
  reload?: () => void
  /** Where a new worker taking over shows. Default: `navigator.serviceWorker`. */
  controllers?: ControllerEvents | undefined
}

/**
 * Asks the site whether a new version exists, unless one is already installing or the device
 * is offline. A failed check (the site is unreachable) changes nothing; the next one tries again.
 */
export async function checkForUpdate(
  registration: UpdatableRegistration,
  isOnline: () => boolean = () => navigator.onLine,
): Promise<void> {
  if (registration.installing || !isOnline()) return
  try {
    await registration.update()
  } catch {
    // Offline after all, or the site is down: the worker in charge keeps serving the app.
  }
}

/**
 * Registers the service worker (pwa/options.ts) once the page has loaded.
 *
 * A new version never takes over by itself, because reloading stops the music: when one is
 * installed and waiting, the store's `updateReady` shows the update toast, and `applyUpdate`
 * activates it. Once it takes over, every open FXM window or tab reloads into it, whichever one
 * the user chose Reload in: the old pages' code belongs to the old version, whose files the new
 * one deletes. While the app is open, it asks the site for a new version every hour. In
 * development, and in the Android and desktop builds, `register` does nothing.
 *
 * Returns a function that stops the update checks and the reload.
 */
export function registerServiceWorker(
  register: RegisterSW,
  {
    store = usePwaStore,
    checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
    isOnline = () => navigator.onLine,
    reload = () => window.location.reload(),
    controllers = globalThis.navigator?.serviceWorker,
  }: ServiceWorkerOptions = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let reloading = false
  let registration: AppRegistration | undefined
  /** The waiting worker the toast offered, to tell a repeated report from a newer version. */
  let offered: ServiceWorker | null = null

  const reloadOnce = () => {
    if (reloading) return
    reloading = true
    reload()
  }

  // A new worker took over this page. With a version on offer, that is the new version, after
  // a Reload here or in another FXM window: reload into it. Workbox reports this only to pages
  // that a service worker controlled from their start (onNeedReload), not to a first visit.
  // Without an offer, it is the first visit's worker taking control, which changes nothing.
  const onTakeover = () => {
    if (store.getState().updateReady) reloadOnce()
  }
  controllers?.addEventListener('controllerchange', onTakeover)

  const update = register({
    onNeedRefresh: () => {
      // Workbox can report one waiting version twice (installed, then waiting 200 ms later):
      // only a newer version undoes "Not now".
      const waiting = registration?.waiting ?? null
      const sameVersion = waiting !== null && waiting === offered
      if (waiting !== null) offered = waiting
      store.setState((state) => ({
        updateReady: true,
        updateDismissed: sameVersion && state.updateDismissed,
      }))
    },
    // The new version took over a page that was controlled from its start.
    onNeedReload: reloadOnce,
    onRegisteredSW: (_url, registered) => {
      if (registered === undefined || stopped) return
      registration = registered
      // A version that already waited when the page loaded was offered before this call.
      if (store.getState().updateReady && offered === null) offered = registered.waiting
      timer = setInterval(() => void checkForUpdate(registered, isOnline), checkIntervalMs)
    },
    onRegisterError: (error: unknown) => {
      console.warn('FXM could not set up offline start; it still works online.', error)
    },
  })

  store.setState({
    applyUpdate: async () => {
      if (registration !== undefined && registration.waiting === null) {
        // Nothing waits any more: another FXM window switched to the new version already (this
        // page then reloads by itself), or the browser did. A reload shows the version in charge.
        reloadOnce()
        return
      }
      await update()
    },
  })

  return () => {
    stopped = true
    clearInterval(timer)
    controllers?.removeEventListener('controllerchange', onTakeover)
  }
}
