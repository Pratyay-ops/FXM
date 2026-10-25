import { useMediaQuery } from '../../lib/use-media-query'
import { type InstallPromptEvent, type PwaStore, usePwaStore } from './pwa-store'

function isInstallPromptEvent(event: Event): event is InstallPromptEvent {
  return typeof (event as Partial<InstallPromptEvent>).prompt === 'function'
}

/**
 * Keeps the browser's install offer for FXM's own install button. Chromium fires
 * `beforeinstallprompt` when it would install the app; deferring it also stops Chrome on Android
 * from showing its install banner over the player. `appinstalled` drops the offer.
 *
 * Call it before the app renders: the event can fire as soon as the page loads. Returns a
 * function that stops listening.
 */
export function listenForInstallPrompt(
  target: Window = window,
  store: PwaStore = usePwaStore,
): () => void {
  const onPrompt = (event: Event) => {
    if (!isInstallPromptEvent(event)) return
    event.preventDefault()
    store.setState({ installPrompt: event })
  }
  const onInstalled = () => store.setState({ installPrompt: undefined })
  target.addEventListener('beforeinstallprompt', onPrompt)
  target.addEventListener('appinstalled', onInstalled)
  return () => {
    target.removeEventListener('beforeinstallprompt', onPrompt)
    target.removeEventListener('appinstalled', onInstalled)
  }
}

/** What came of an install request. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

/**
 * Shows the browser's install dialog. Call it straight from a click handler: browsers show the
 * dialog only during a user gesture. An offer can be used once, so it is dropped either way (the
 * browser offers again later if the user said no). `unavailable` means there was no offer.
 */
export async function promptInstall(store: PwaStore = usePwaStore): Promise<InstallOutcome> {
  const event = store.getState().installPrompt
  if (event === undefined) return 'unavailable'
  store.setState({ installPrompt: undefined })
  try {
    await event.prompt()
    return (await event.userChoice).outcome
  } catch {
    return 'dismissed'
  }
}

/** An installed app window without browser controls. */
export const STANDALONE_QUERY = '(display-mode: standalone)'
/** An installed desktop window whose title bar the page draws (Window Controls Overlay). */
export const WINDOW_CONTROLS_OVERLAY_QUERY = '(display-mode: window-controls-overlay)'

/** iOS sets `navigator.standalone` in apps added to the Home Screen. */
function isIosHomeScreenApp(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Whether FXM runs as an installed app: in its own window, or from the iOS Home Screen. */
export function useRunningAsApp(): boolean {
  const standalone = useMediaQuery(STANDALONE_QUERY)
  const overlay = useMediaQuery(WINDOW_CONTROLS_OVERLAY_QUERY)
  return standalone || overlay || isIosHomeScreenApp()
}

/**
 * How this visitor can install FXM:
 *
 * - `installed`: it already runs as an app
 * - `prompt`: the browser offers to install it (Chromium), so FXM shows an install button
 * - `ios`: iPhone and iPad install from the Share menu
 * - `mac-safari`: Safari on a Mac adds web apps to the Dock from its File menu
 * - `browser`: anything else; browsers that install web apps do it from their own menu
 */
export type InstallHint = 'installed' | 'prompt' | 'ios' | 'mac-safari' | 'browser'

export interface InstallContext {
  runningAsApp: boolean
  canPrompt: boolean
  userAgent: string
  /** iPadOS reports a Mac user agent, but a touch screen. */
  maxTouchPoints: number
}

/** Picks the {@link InstallHint} for a browser. */
export function installHint({
  runningAsApp,
  canPrompt,
  userAgent,
  maxTouchPoints,
}: InstallContext): InstallHint {
  if (runningAsApp) return 'installed'
  if (canPrompt) return 'prompt'
  const mac = /Macintosh/.test(userAgent)
  if (/iPhone|iPad|iPod/.test(userAgent) || (mac && maxTouchPoints > 1)) return 'ios'
  const safari =
    /Version\/[\d.]+.*Safari\//.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent)
  return mac && safari ? 'mac-safari' : 'browser'
}

/** The {@link InstallHint} for this browser, updated when the offer or the window changes. */
export function useInstallHint(): InstallHint {
  const runningAsApp = useRunningAsApp()
  const canPrompt = usePwaStore((state) => state.installPrompt !== undefined)
  return installHint({
    runningAsApp,
    canPrompt,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  })
}
