import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { type PwaStore, usePwaStore } from './pwa-store'

/** `registerSW` from `virtual:pwa-register`: main.tsx passes the real one, tests a fake. */
export type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

/** How often an open window asks the site for a new version: FXM can stay open for days. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000

/** The parts of a `ServiceWorkerRegistration` the update check uses. */
export type UpdatableRegistration = Pick<ServiceWorkerRegistration, 'installing' | 'update'>

/** The part of `navigator.serviceWorker` that reports a new worker taking over the page. */
export type ControllerEvents = Pick<ServiceWorkerContainer, 'addEventListener'>

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
 * activates it and reloads the page into it. While the app is open, it asks the site for a new
 * version every hour. In development, and in the Android and desktop builds, `register` does
 * nothing.
 *
 * Returns a function that stops the update checks.
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
  const reloadOnce = () => {
    if (reloading) return
    reloading = true
    reload()
  }

  const update = register({
    onNeedRefresh: () => store.setState({ updateReady: true, updateDismissed: false }),
    // The new version took over a page that was controlled from its start.
    onNeedReload: reloadOnce,
    onRegisteredSW: (_url, registration) => {
      if (registration === undefined || stopped) return
      timer = setInterval(() => void checkForUpdate(registration, isOnline), checkIntervalMs)
    },
    onRegisterError: (error: unknown) => {
      console.warn('FXM could not set up offline start; it still works online.', error)
    },
  })

  store.setState({
    applyUpdate: async () => {
      // vite-plugin-pwa reports the takeover (onNeedReload) only for a page that a service worker
      // controlled when it loaded. On a first visit the worker takes control mid-session, so watch
      // for the takeover here too: after this click, it can only be the new version.
      controllers?.addEventListener('controllerchange', reloadOnce, { once: true })
      await update()
    },
  })

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
