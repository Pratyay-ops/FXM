/**
 * When the Android app checks for a new version of itself (stage 6.6): a while after it starts,
 * then once a day while it is used, unless the user turned that off in Settings, and whenever the
 * user asks there. A check is one GET request to GitHub's API ({@link fetchLatestRelease}). It
 * only finds out: the app never downloads or installs anything by itself, it offers the APK's
 * link (the toast and Settings), and the browser downloads it and Android's installer asks
 * before it updates FXM.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import { type UpdateFetch, unpatchedFetch } from '@fxm/platform'
import { type AppUpdateProblem, type AppUpdateStore, useAppUpdateStore } from './app-update-store'
import { fetchLatestRelease } from './releases'
import { type AppUpdateSupport, buildAppUpdateSupport } from './support'

/** How long after a successful check the next one is due. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000

/** How long after a failed check the next one is due, unless GitHub asks for longer. */
export const RETRY_INTERVAL_MS = 60 * 60_000

/** How long after start-up the first check waits, so it never slows the app's start. */
export const FIRST_CHECK_DELAY_MS = 10_000

/** How often a running app looks whether a check is due. */
export const DUE_CHECK_INTERVAL_MS = 15 * 60_000

/**
 * The WebView's own `fetch` as an {@link UpdateFetch}: without cookies, a `Referer` or the HTTP
 * cache. GitHub's API answers every origin (`Access-Control-Allow-Origin: *`). Once
 * `api.github.com` is on the platform's host list, the app may pass `updateFetchFromNative` with
 * the Android app's native HTTP instead.
 */
export const webUpdateFetch: UpdateFetch = (url, init) =>
  unpatchedFetch()(url, { ...init, cache: 'no-store', referrerPolicy: 'no-referrer' })

/** What a check uses; each defaults to the app's. */
export interface AppUpdateCheckOptions {
  readonly store?: AppUpdateStore
  readonly fetch?: UpdateFetch
  readonly now?: () => number
  /** Whether the device is online. Default: `navigator.onLine`. */
  readonly isOnline?: () => boolean
}

/** The check under way, which every caller shares. */
let running: Promise<void> | undefined

/**
 * Checks GitHub for FXM's newest release now, and records what it found or why it failed in the
 * store. Never rejects. While one runs, callers share it.
 */
export function checkForAppUpdate(options: AppUpdateCheckOptions = {}): Promise<void> {
  running ??= runCheck(options).finally(() => {
    running = undefined
  })
  return running
}

async function runCheck({
  store = useAppUpdateStore,
  fetch = webUpdateFetch,
  now = Date.now,
  isOnline = () => globalThis.navigator?.onLine !== false,
}: AppUpdateCheckOptions): Promise<void> {
  if (!isOnline()) {
    // Nothing to ask. The check is due now, so the `online` event makes it (startAppUpdateChecks),
    // also after a "Check now" less than a day after the last check.
    store.setState({
      problem: 'offline',
      nextCheckAt: Math.min(store.getState().nextCheckAt, now()),
    })
    return
  }
  store.setState({ checking: true })
  try {
    const latest = await fetchLatestRelease(fetch, { now })
    const at = now()
    store.setState({
      latest: latest ?? null,
      lastCheckedAt: at,
      nextCheckAt: at + CHECK_INTERVAL_MS,
      checking: false,
      problem: null,
    })
  } catch (error) {
    const problem: AppUpdateProblem = isFxmError(error, 'RateLimited')
      ? 'rate-limited'
      : isFxmError(error, 'Parse')
        ? 'unexpected'
        : 'unreachable'
    // At least an hour, or as long as GitHub's rate limit asks, but never more than a day: a
    // longer wait, as from a device clock days behind GitHub's x-ratelimit-reset, would look like
    // a clock that went back to isCheckDue, which would then ask at every look.
    const asked = isFxmError(error, 'RateLimited') ? (error.retryAfterMs ?? 0) : 0
    const wait = Math.min(CHECK_INTERVAL_MS, Math.max(RETRY_INTERVAL_MS, asked))
    store.setState({ nextCheckAt: now() + wait, checking: false, problem })
  }
}

/**
 * Whether a scheduled check is due. A `nextCheckAt` further away than a day, as after the
 * device's clock went back, counts as due.
 */
export function isCheckDue(nextCheckAt: number, now: number): boolean {
  return now >= nextCheckAt || nextCheckAt - now > CHECK_INTERVAL_MS
}

/** Where a page's events come from. */
type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** What {@link startAppUpdateChecks} uses; each defaults to the app's. */
export interface AppUpdateScheduleOptions extends AppUpdateCheckOptions {
  /** Whether this build checks at all. Default: {@link buildAppUpdateSupport}. */
  readonly support?: AppUpdateSupport
  /** The page, which says when it comes back to the foreground. Default: `document`. */
  readonly page?: EventSource & Pick<Document, 'visibilityState'>
  /** Where `online` comes from. Default: `window`. */
  readonly network?: EventSource
}

/**
 * Starts the scheduled checks of a build that checks (see {@link buildAppUpdateSupport}): the first
 * {@link FIRST_CHECK_DELAY_MS} after start-up if one is due, then whenever one is due, looked at
 * every {@link DUE_CHECK_INTERVAL_MS} while the app is in the foreground, when it comes back to
 * it and when the device goes online. While the user has them off (`autoCheck`), each look asks
 * nothing. Returns a function that stops them.
 */
export function startAppUpdateChecks(options: AppUpdateScheduleOptions = {}): () => void {
  const {
    support = buildAppUpdateSupport(),
    store = useAppUpdateStore,
    now = Date.now,
    page = globalThis.document,
    network = globalThis.window,
  } = options
  if (!support.checks) return () => {}
  const checkIfDue = () => {
    if (page !== undefined && page.visibilityState !== 'visible') return
    const { autoCheck, nextCheckAt } = store.getState()
    if (autoCheck && isCheckDue(nextCheckAt, now())) void checkForAppUpdate(options)
  }
  const first = setTimeout(checkIfDue, FIRST_CHECK_DELAY_MS)
  const timer = setInterval(checkIfDue, DUE_CHECK_INTERVAL_MS)
  page?.addEventListener('visibilitychange', checkIfDue)
  network?.addEventListener('online', checkIfDue)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    page?.removeEventListener('visibilitychange', checkIfDue)
    network?.removeEventListener('online', checkIfDue)
  }
}

/** Marks the offer of a version as answered: the toast doesn't show it again. */
export function dismissAppUpdate(version: string, store: AppUpdateStore = useAppUpdateStore): void {
  store.setState({ dismissedVersion: version })
}

/**
 * Turns the daily checks on or off (Settings → About → "Check for new versions"). Off, the app
 * asks GitHub only when the user taps "Check now".
 */
export function setAutoCheck(on: boolean, store: AppUpdateStore = useAppUpdateStore): void {
  store.setState({ autoCheck: on })
}
