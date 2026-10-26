/**
 * The account feature at run time: whether the account can be used here and is logged in, the
 * sync (when it runs, one tab at a time), Connect and Disconnect, and Home's Spotify sections.
 * One runtime per app (`start.ts`); tests make their own over fake services.
 *
 * - **Opt-in.** Nothing happens until the user connects the account after its notice. The
 *   choice is persisted (`account-store.ts`) and followed by every open tab: a Disconnect in one
 *   tab stops the account in all of them.
 * - **Tokens** never pass through here: the provider keeps them in memory and asks FXM Connect's
 *   bridge for them, or the Android app's login (stage 6.5; desktop's comes later). Disconnect
 *   makes it forget them.
 * - **The app's own login window** (Android, `services.loginWindow`): the login is the app's to
 *   keep, so the check and Home ask the window first, Connect opens it when no login is kept,
 *   Log in opens it again, and Disconnect also logs out of it, and says when it couldn't. The
 *   state says whether a login is kept (`loginKept`) even while the account is off, so Settings
 *   can offer to log out of a login a Disconnect couldn't delete.
 * - **When it syncs:** right after Connect, when the app opens and the last sync is older than
 *   {@link SYNC_EVERY_MS}, every so often while it stays open, and on "Sync now". A sync that
 *   stopped at its budget of requests goes on after {@link CONTINUE_AFTER_MS}. One tab syncs at a
 *   time (a Web Lock); the others see the result in the library. A login check that failed (the
 *   network, FXM Connect answering too late) is tried again on the same schedule, so a passing
 *   failure when the app opens doesn't stop the sync until the user notices.
 * - **Disconnect wins.** A sync, or a read of the home for Home, that started before a Disconnect
 *   (in this tab or another) never writes the sync's state after it, even once the account is
 *   connected again.
 *
 * @module
 */

import {
  type AccountStatus,
  applyModeFilter,
  isFxmError,
  type ProviderContext,
  type Shelf,
} from '@fxm/core'
import type { SpotifyLoginState } from '@fxm/platform'
import { isSpotifyError } from '@fxm/sources/spotify'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { LibraryError } from '../../db/repo'
import type { AccountChoiceStore } from './account-store'
import { HOME_FRESH_MS, HOME_KEEP_MS, readHome } from './home'
import { accountKeyOf } from './ids'
import { browserLocks, type LockManagerLike, SYNC_LOCK } from './locks'
import type { SpotifyAccountServices } from './services'
import { forgetState, readMeta, type SyncMeta } from './state'
import {
  type ForgetResult,
  forgetSync,
  runSpotifySync,
  type SyncLimits,
  type SyncProgress,
  writeHome,
} from './sync'

/** How old the last sync may get before the app syncs again by itself. */
export const SYNC_EVERY_MS = 6 * 60 * 60_000

/**
 * How soon a sync that stopped at its budget of requests goes on: at the first check after
 * that long, so about an hour later.
 */
export const CONTINUE_AFTER_MS = 30 * 60_000

/**
 * How often an open app checks whether a sync is due, and checks the login again after a check
 * that failed.
 */
export const CHECK_EVERY_MS = 30 * 60_000

/** The pause between two of a sync's requests to Spotify: about one a second, as imports do. */
export const SYNC_PACE_MS = 1000

/**
 * Where the account stands here:
 *
 * - `off`: not connected in FXM (the opt-in is off)
 * - `checking`: asking whether the login works
 * - `connected`: logged in; the sync can run
 * - `logged-out`: FXM Connect gets no Spotify login from this browser: not signed in to
 *   Spotify, or the browser keeps Spotify's cookies from FXM Connect
 * - `needs-login`: FXM Connect's "Use my Spotify login from this browser" is off (in Firefox:
 *   or its consent was withdrawn)
 * - `private`: a private window or a container tab, where FXM Connect never uses the login
 * - `unreachable`: Spotify can't be reached here (no FXM Connect), or is switched off
 * - `unsupported`: this app has no Spotify login yet (desktop: stage 7.4), or its login window
 *   can't open here (the Android app on a WebView without profiles)
 * - `unverified`: the check itself failed (the network, FXM Connect not answering in time):
 *   `failure` says why, and Try again checks again, as does the next tick of the schedule
 */
export type AccountPhase =
  | 'off'
  | 'checking'
  | 'connected'
  | 'logged-out'
  | 'needs-login'
  | 'private'
  | 'unreachable'
  | 'unsupported'
  | 'unverified'

/**
 * Why the last sync in this tab failed:
 *
 * - `rate-limited`: Spotify asked FXM to slow down (`retryAt` says until when, when known)
 * - `secret`: Spotify's web-player secret stopped working (FXM pauses Spotify)
 * - `changed`: Spotify answered in a way FXM doesn't understand: it changed something FXM uses
 * - `network`: Spotify or FXM Connect couldn't be reached
 * - `storage`: the library couldn't save (the browser's storage is full or blocked)
 * - `other`: anything else
 */
export interface SyncFailure {
  readonly kind: 'rate-limited' | 'secret' | 'changed' | 'network' | 'storage' | 'other'
  readonly retryAt?: number
}

/** The runtime's state, for Settings. */
export interface AccountRuntimeState {
  readonly phase: AccountPhase
  /** The account's display name, once the login worked. */
  readonly displayName?: string
  /** Whether a sync runs in this tab. */
  readonly syncing: boolean
  /** Where it stands. */
  readonly progress?: SyncProgress
  /** Whether another tab was syncing when this one wanted to, until that sync ends. */
  readonly syncingElsewhere: boolean
  /** Why this tab's last sync failed, until the next one. */
  readonly failure?: SyncFailure
  /**
   * Where the app keeps the login itself (Android): whether it keeps one on this device, once the
   * runtime asked. It can outlive the account: a Disconnect that couldn't delete it.
   */
  readonly loginKept?: boolean
}

/** How long Disconnect waits for another tab's sync to stop before it goes on regardless. */
export const DISCONNECT_WAIT_MS = 10_000

/**
 * What opening the app's own login window came to:
 *
 * - `done`: it opened and closed, and the check that followed says where the account stands
 *   (`connected`, or `logged-out` when the user closed it without logging in)
 * - `unavailable`: it can't open here (no login window, or an Android WebView without profiles)
 * - `failed`: it couldn't open (no screen, or it is open already), or couldn't keep the login
 */
export type LoginOutcome = 'done' | 'unavailable' | 'failed'

/** What Disconnect did: to the library, and to the app's own login. */
export interface DisconnectResult extends ForgetResult {
  /**
   * Where the app keeps the login itself (Android): whether a login is still kept after logging
   * out, `true` when logging out failed. Absent where the app keeps none (the web).
   */
  readonly loginKept?: boolean
}

/** Options for {@link createAccountRuntime}. */
export interface AccountRuntimeOptions {
  /** The services: the provider, the library, the platform. */
  readonly services: SpotifyAccountServices
  /** The user's choice (the opt-in). */
  readonly choice: AccountChoiceStore
  /** Web Locks. Default: the browser's, when it has them. */
  readonly locks?: LockManagerLike
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number
  /** Waits between a sync's requests. Default: a timer of {@link SYNC_PACE_MS}. */
  readonly pace?: (signal?: AbortSignal) => Promise<void>
  /** Runs `check` every `ms`; returns a function that stops it. Default: `setInterval`. */
  readonly every?: (check: () => void, ms: number) => () => void
  /** How long Disconnect waits for another tab's sync to stop. Default {@link DISCONNECT_WAIT_MS}. */
  readonly disconnectWaitMs?: number
  /** Lower limits for each sync, for tests. */
  readonly limits?: Partial<SyncLimits>
}

/** Home's view of the account: stage 3.3's `HomeSpotifyAccount`. */
export interface AccountForHome {
  /** Whether the account is connected and logged in. */
  status(ctx: ProviderContext): Promise<AccountStatus>
  /** The account's personal home sections, from the sync (fresh within half an hour). */
  sections(ctx: ProviderContext): Promise<readonly Shelf[]>
}

/** The runtime. */
export interface AccountRuntime {
  /** Its state; subscribe for changes. */
  readonly store: StoreApi<AccountRuntimeState>
  /** Home's view of the account. */
  readonly forHome: AccountForHome
  /**
   * Connects the account after the user accepted the notice: the opt-in goes on, the login is
   * checked, and a first sync starts in the background when it works. Resolves after the check.
   * Where the app keeps the login itself and none is kept yet (Android), it opens the login
   * window first ({@link AccountRuntime.login}) and resolves with what that came to.
   */
  connect(): Promise<LoginOutcome | undefined>
  /**
   * Opens the app's own Spotify login window (Android), where the user logs in on Spotify's page;
   * once it closes, checks the login again and syncs when it works. Opening it again while it is
   * open shares the first call.
   */
  login(): Promise<LoginOutcome>
  /**
   * Disconnects: the opt-in goes off, the provider forgets the account's token at once, a
   * running sync stops, and the sync's state and the personal home are forgotten. The copies
   * stay, unless `removeCopies` (then those nobody changed go; see `forgetSync`). Where the app
   * keeps the login itself (Android), it also logs out of the login window, and the result says
   * whether a login is still kept (`loginKept`): Disconnect goes on when logging out fails.
   */
  disconnect(options?: { removeCopies?: boolean }): Promise<DisconnectResult>
  /**
   * Logs out of the app's own login window (Android): deletes the login the app keeps, e.g. one
   * a Disconnect couldn't delete. Resolves with whether a login is still kept (`true` when
   * logging out failed), or `undefined` where the app keeps no login of its own. While the
   * account is connected, it is logged out then.
   */
  logout(): Promise<boolean | undefined>
  /** Asks again whether the login works ("Try again"), and starts a sync when one is due. */
  recheck(): Promise<void>
  /** Syncs now, unless another tab does. Resolves when the sync ends (a running one's too). */
  syncNow(): Promise<void>
  /** Resolves once no login check, no check whether a sync is due and no sync is in flight. */
  whenIdle(): Promise<void>
  /** Starts following the opt-in, the capabilities and the clock. Returns a function to stop. */
  start(): () => void
}

const INITIAL: AccountRuntimeState = { phase: 'off', syncing: false, syncingElsewhere: false }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The connect code of FXM Connect's refusal behind an error, if any. */
function connectCodeOf(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    const code = (current as { connectCode?: unknown }).connectCode
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Where the account stands after `error`, when it says something about the login: the phase, or
 * `undefined` for a failure that isn't about the login.
 */
export function phaseOfError(error: unknown): AccountPhase | undefined {
  const code = connectCodeOf(error)
  if (code === 'private-tab') return 'private'
  if (code === 'login-disabled') return 'needs-login'
  if (isSpotifyError(error, 'disabled') || isSpotifyError(error, 'unreachable')) {
    return 'unreachable'
  }
  if (isSpotifyError(error, 'account-unsupported')) return 'needs-login'
  if (isSpotifyError(error, 'account-disabled')) return 'off'
  if (
    isSpotifyError(error, 'login-required') ||
    isSpotifyError(error, 'token-rejected') ||
    isFxmError(error, 'AuthRequired')
  ) {
    return 'logged-out'
  }
  return undefined
}

/** Why a sync failed, for a failure that isn't about the login. */
export function failureOfError(error: unknown, now: number): SyncFailure {
  if (
    error instanceof LibraryError ||
    (error as { name?: unknown })?.name === 'QuotaExceededError'
  ) {
    return { kind: 'storage' }
  }
  if (isSpotifyError(error, 'secret-rejected') || isSpotifyError(error, 'secret-unavailable')) {
    return { kind: 'secret' }
  }
  if (isFxmError(error, 'RateLimited')) {
    const after = (error as { retryAfterMs?: unknown }).retryAfterMs
    return typeof after === 'number' && after > 0
      ? { kind: 'rate-limited', retryAt: now + after }
      : { kind: 'rate-limited' }
  }
  if (isFxmError(error, 'Network')) return { kind: 'network' }
  if (
    isSpotifyError(error, 'operation-broken') ||
    isSpotifyError(error, 'operation-unsupported') ||
    isSpotifyError(error, 'bad-response') ||
    isSpotifyError(error, 'graphql') ||
    isSpotifyError(error, 'client-rejected') ||
    isFxmError(error, 'Parse')
  ) {
    return { kind: 'changed' }
  }
  return { kind: 'other' }
}

/** Creates the runtime. It does nothing until {@link AccountRuntime.start} or a call. */
export function createAccountRuntime(options: AccountRuntimeOptions): AccountRuntime {
  const { services, choice } = options
  const { spotify, library } = services
  const now = options.now ?? Date.now
  const locks = options.locks ?? browserLocks()
  const pace = options.pace ?? ((signal?: AbortSignal) => sleep(SYNC_PACE_MS, signal))
  const every =
    options.every ??
    ((check: () => void, ms: number) => {
      const timer = setInterval(check, ms)
      return () => clearInterval(timer)
    })
  const disconnectWaitMs = options.disconnectWaitMs ?? DISCONNECT_WAIT_MS
  const store = createStore<AccountRuntimeState>()(() => INITIAL)
  const set = (patch: Partial<AccountRuntimeState>) => store.setState(patch)
  /** Sets `patch` and removes `drop` (zustand merges, so removing takes a replace). */
  const update = (
    patch: Partial<AccountRuntimeState>,
    drop: readonly ('failure' | 'progress')[],
  ) => {
    const next: Record<string, unknown> = { ...store.getState(), ...patch }
    for (const key of drop) delete next[key]
    store.setState(next as unknown as AccountRuntimeState, true)
  }
  let running: { controller: AbortController; done: Promise<void> } | undefined
  let checking: Promise<AccountPhase> | undefined
  /** A check whether a sync is due, from its read of the last sync to the sync it starts. */
  let due: Promise<void> | undefined
  /** The wait for another tab's sync to end, after this tab found the lock taken. */
  let waiting: AbortController | undefined
  let loggingIn: Promise<LoginOutcome> | undefined
  /** Whether this runtime changes the choice itself, so it doesn't follow its own change. */
  let ownChange = false
  /**
   * How many Disconnects this runtime saw, here or from another tab. A sync or a read of the
   * home writes the sync's state only while the count is the one it started with: a Disconnect
   * meanwhile forgot that state, and the account may even be connected again since.
   */
  let disconnects = 0

  const optedIn = () => choice.getState().optedIn
  /** Whether work started at `count` Disconnects may still write the sync's state. */
  const stillConnected = (count: number) => optedIn() && disconnects === count

  /** Where the account stands from what the app knows without a request, if it can tell. */
  function phaseWithoutRequest(): AccountPhase | undefined {
    if (!optedIn()) return 'off'
    if (!services.spotifyEnabled()) return 'unreachable'
    const access = services.capabilities().spotify
    if (access === 'unreachable') return 'unreachable'
    if (access === 'anonymous') {
      return services.context('interactive').platform === 'web' ? 'needs-login' : 'unsupported'
    }
    return undefined
  }

  /** Asks the app's own login window whether it keeps a login: a question to the app, no request. */
  async function askKept(): Promise<void> {
    const kept = await services.loginWindow?.loginState().catch(() => undefined)
    if (kept !== undefined) set({ loginKept: kept.loggedIn })
  }

  /**
   * Logs out of the app's own login window. Resolves with whether a login is still kept, `true`
   * when logging out failed, or `undefined` without a window.
   */
  async function logOutOfWindow(): Promise<boolean | undefined> {
    const { loginWindow } = services
    if (loginWindow === undefined) return undefined
    let kept: boolean
    try {
      kept = (await loginWindow.logout()).loggedIn
    } catch {
      // It failed, at least in part: ask what is left, and count a window that won't say as
      // keeping the login.
      kept = await loginWindow.loginState().then(
        (state) => state.loggedIn,
        () => true,
      )
    }
    set({ loginKept: kept })
    return kept
  }

  async function askLogin(): Promise<AccountPhase> {
    // A failure that came from a failed check goes once a check gets an answer.
    const checkFailed = store.getState().phase === 'unverified'
    const drop: readonly 'failure'[] = checkFailed ? ['failure'] : []
    const known = phaseWithoutRequest()
    if (known !== undefined) {
      update({ phase: known }, drop)
      return known
    }
    set({ phase: 'checking' })
    try {
      // The app's own login first: without one kept, asking Spotify would only cost requests.
      const kept = await services.loginWindow?.loginState()
      if (kept !== undefined) set({ loginKept: kept.loggedIn })
      if (kept !== undefined && (!kept.available || !kept.loggedIn)) {
        const phase = !optedIn() ? 'off' : kept.available ? 'logged-out' : 'unsupported'
        update({ phase }, drop)
        return phase
      }
      const status = await spotify.status(services.context('interactive'))
      if (!optedIn()) {
        update({ phase: 'off' }, drop)
        return 'off'
      }
      if (!status.connected) {
        const phase = phaseWithoutRequest() ?? 'logged-out'
        update({ phase }, drop)
        return phase
      }
      update(
        {
          phase: 'connected',
          ...(status.displayName === undefined ? {} : { displayName: status.displayName }),
        },
        drop,
      )
      return 'connected'
    } catch (error) {
      const phase = phaseOfError(error)
      if (phase === undefined) {
        // Not about the login (the network, FXM Connect too slow): the check itself failed.
        set({ phase: 'unverified', failure: failureOfError(error, now()) })
        return 'unverified'
      }
      update({ phase }, drop)
      return phase
    }
  }

  /** Asks whether the login works, once at a time. */
  function check(): Promise<AccountPhase> {
    checking ??= askLogin().finally(() => {
      checking = undefined
    })
    return checking
  }

  async function lastSync(): Promise<SyncMeta | undefined> {
    try {
      return await readMeta(library)
    } catch {
      return undefined
    }
  }

  /**
   * Syncs when one is due, once at a time. The check is in flight from its first step, so
   * {@link AccountRuntime.whenIdle} waits for it even before the sync starts.
   */
  function syncIfDue(): Promise<void> {
    due ??= (async () => {
      if (store.getState().phase !== 'connected' || running) return
      const meta = await lastSync()
      const { failure } = store.getState()
      if (failure?.retryAt !== undefined && failure.retryAt > now()) return
      const last = meta?.lastSyncAt
      // A sync that stopped at its budget goes on sooner than the next regular one.
      const wait = (meta?.last?.pending ?? 0) > 0 ? CONTINUE_AFTER_MS : SYNC_EVERY_MS
      if (last === undefined || now() - last >= wait) await syncNow()
    })()
      .catch(() => undefined)
      .finally(() => {
        due = undefined
      })
    return due
  }

  /** The schedule's tick: checks the login again after a failed check, then syncs when due. */
  async function tick(): Promise<void> {
    if (!optedIn()) return
    const { phase, failure } = store.getState()
    if (phase === 'unverified') {
      if (failure?.retryAt !== undefined && failure.retryAt > now()) return
      if ((await check()) !== 'connected') return
    }
    await syncIfDue()
  }

  async function runSync(signal: AbortSignal): Promise<void> {
    const count = disconnects
    set({ syncing: true, syncingElsewhere: false, progress: { step: 'account' } })
    try {
      const result = await runSpotifySync(spotify, library, {
        context: () => services.context('bulk'),
        signal,
        pace,
        now,
        guard: () => stillConnected(count),
        onProgress: (progress) => set({ progress }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      })
      // The login worked; unless something said otherwise meanwhile (a capability that changed).
      const { phase } = store.getState()
      update(
        {
          ...(phase === 'checking' || phase === 'connected' ? { phase: 'connected' } : {}),
          ...(result.displayName === undefined ? {} : { displayName: result.displayName }),
        },
        ['failure'],
      )
    } catch (error) {
      if (signal.aborted || !stillConnected(count)) return
      const phase = phaseOfError(error)
      if (phase !== undefined) set({ phase })
      else set({ failure: failureOfError(error, now()) })
    } finally {
      update({ syncing: false }, ['progress'])
    }
  }

  /**
   * Waits, in the background, for the sync another tab runs, so that Settings stops saying so
   * once it ends. Never holds the lock longer than it takes to learn that.
   */
  function waitForOtherTab(): void {
    if (locks === undefined || waiting !== undefined) return
    const controller = new AbortController()
    waiting = controller
    locks
      .request(SYNC_LOCK, { signal: controller.signal }, async () => {})
      .then(
        () => {
          if (!controller.signal.aborted) set({ syncingElsewhere: false })
        },
        () => undefined,
      )
      .finally(() => {
        if (waiting === controller) waiting = undefined
      })
  }

  function stopWaiting(): void {
    waiting?.abort(new DOMException('No longer waiting', 'AbortError'))
    waiting = undefined
  }

  async function syncNow(): Promise<void> {
    if (!optedIn() || running) return running?.done
    const controller = new AbortController()
    const work = async () => {
      if (locks === undefined) {
        await runSync(controller.signal)
        return
      }
      const ran = await locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock === null) return false
        await runSync(controller.signal)
        return true
      })
      if (!ran) {
        set({ syncingElsewhere: true })
        waitForOtherTab()
      }
    }
    const done = work().finally(() => {
      if (running?.controller === controller) running = undefined
    })
    running = { controller, done }
    return done
  }

  function stopSync(): Promise<void> | undefined {
    const current = running
    if (!current) return undefined
    current.controller.abort(new DOMException('Spotify was disconnected', 'AbortError'))
    return current.done
  }

  async function openLoginWindow(): Promise<LoginOutcome> {
    const { loginWindow } = services
    if (loginWindow === undefined) return 'unavailable'
    if (!optedIn()) return 'failed'
    let state: SpotifyLoginState
    try {
      state = await loginWindow.openLogin()
    } catch {
      return 'failed'
    }
    set({ loginKept: state.loggedIn })
    if (!state.available) {
      update({ phase: 'unsupported' }, [])
      return 'unavailable'
    }
    // A new login, or the same: forget a remembered logged-out answer, and ask again, after any
    // check that started while the window was open (it may not have seen the new login).
    spotify.connect()
    await checking
    // A login may be another account's: sync at once, so the copies follow the account in use.
    if ((await check()) === 'connected') void syncNow()
    return 'done'
  }

  function login(): Promise<LoginOutcome> {
    loggingIn ??= openLoginWindow().finally(() => {
      loggingIn = undefined
    })
    return loggingIn
  }

  async function logout(): Promise<boolean | undefined> {
    const kept = await logOutOfWindow()
    if (kept === false && optedIn()) {
      // Connected: the provider forgets the account's token, and the check finds no login.
      spotify.connect()
      await checking
      await check()
    }
    return kept
  }

  async function recheck(): Promise<void> {
    if (!optedIn()) return
    spotify.connect()
    // The user may have just changed FXM Connect's options: detect it again first.
    await services.refresh().catch(() => undefined)
    if ((await check()) === 'connected') void syncIfDue()
  }

  /** Follows the choice when another tab changes it. */
  function onChoice(on: boolean, before: boolean): void {
    if (on === before || ownChange) return
    if (on) {
      spotify.connect()
      void check()
    } else {
      disconnects += 1
      spotify.disconnect()
      stopWaiting()
      void stopSync()
      update({ phase: 'off', syncing: false, syncingElsewhere: false }, ['failure', 'progress'])
    }
  }

  const forHome: AccountForHome = {
    async status(ctx) {
      if (!optedIn()) return { connected: false }
      // The app's own login first, as the check does: without one kept, the provider would still
      // load the secret and ask Spotify's clock before the window refuses the token.
      const kept = await services.loginWindow?.loginState()
      if (kept !== undefined && !(kept.available && kept.loggedIn)) return { connected: false }
      return spotify.status(services.context('interactive', ctx.signal))
    },
    async sections(ctx) {
      if (!optedIn()) return []
      const count = disconnects
      const [meta, kept] = await Promise.all([readMeta(library), readHome(library)])
      // Disconnected meanwhile: Home shows nothing of the account.
      if (!stillConnected(count)) return []
      const account = meta?.account
      const own = kept !== undefined && kept.account === account
      const filtered = (shelves: readonly Shelf[]) =>
        shelves
          .map((shelf) => ({
            ...shelf,
            items: shelf.items.filter(
              (item) => item.type !== 'track' || applyModeFilter([item.track], ctx.mode).length > 0,
            ),
          }))
          .filter((shelf) => shelf.items.length > 0)
      if (own && now() - kept.at < HOME_FRESH_MS) return filtered(kept.shelves)
      try {
        const live = services.context('interactive', ctx.signal)
        const shelves = await spotify.getAccountHome(live)
        const profile = await spotify.getAccountProfile(live)
        // Kept only for the account the copies follow: another login's home isn't theirs.
        const ours =
          account !== undefined &&
          profile.username !== undefined &&
          (await accountKeyOf(profile.username)) === account
        // Checked right before the write: a Disconnect meanwhile forgot the home, and it stays
        // forgotten.
        if (!stillConnected(count)) return []
        if (ours) await writeHome(library, { account, at: now(), shelves })
        return filtered(shelves)
      } catch (error) {
        if (ctx.signal?.aborted) throw error
        return own && now() - kept.at < HOME_KEEP_MS ? filtered(kept.shelves) : []
      }
    },
  }

  return {
    store,
    forHome,
    async connect() {
      ownChange = true
      try {
        choice.getState().setOptedIn(true)
      } finally {
        ownChange = false
      }
      spotify.connect()
      update({}, ['failure'])
      const phase = await check()
      // The first sync goes on in the background: Disconnect stays possible meanwhile.
      if (phase === 'connected') void syncNow()
      // Where the app keeps the login itself, connecting is logging in.
      else if (phase === 'logged-out' && services.loginWindow !== undefined) return login()
      return undefined
    },
    login,
    logout,
    async disconnect({ removeCopies = false } = {}) {
      disconnects += 1
      const count = disconnects
      ownChange = true
      try {
        choice.getState().setOptedIn(false)
      } finally {
        ownChange = false
      }
      spotify.disconnect()
      stopWaiting()
      // The login is the app's own: it goes too. Disconnect goes on if it can't, and says so.
      const loginKept = await logOutOfWindow()
      await stopSync()
      update({ phase: 'off', syncing: false, syncingElsewhere: false }, ['failure', 'progress'])
      const forget = async (): Promise<DisconnectResult> => {
        const forgot = await forgetSync(library, { removeCopies })
        return loginKept === undefined ? forgot : { ...forgot, loginKept }
      }
      if (locks === undefined) return forget()
      // Another tab's sync stops as soon as it sees the choice: wait for it to let go, but not
      // forever (a tab the browser froze in the background).
      try {
        return await locks.request(
          SYNC_LOCK,
          { signal: AbortSignal.timeout(disconnectWaitMs) },
          forget,
        )
      } catch (error) {
        if ((error as { name?: unknown })?.name !== 'TimeoutError') throw error
        const result = await forget()
        // That tab may still write what it was syncing before it learns of the Disconnect: once
        // it lets go, forget that too, unless the account was connected again meanwhile. The
        // app's next start tidies up as well (`tidy.ts`), should this tab close first.
        locks
          .request(SYNC_LOCK, {}, async () => {
            if (!optedIn() && disconnects === count) await forgetState(library)
          })
          .catch(() => undefined)
        return result
      }
    },
    recheck,
    syncNow,
    async whenIdle() {
      for (
        let rounds = 0;
        rounds < 100 && (checking !== undefined || due !== undefined || running !== undefined);
        rounds++
      ) {
        await checking
        await due
        await running?.done.catch(() => undefined)
        // A check may start a sync once it resolves, a microtask later.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    start() {
      let before = optedIn()
      const stopChoice = choice.subscribe((state) => {
        const on = state.optedIn
        const was = before
        before = on
        onChoice(on, was)
      })
      const stopServices = services.subscribe(() => {
        if (!optedIn()) return
        void check().then((phase) => (phase === 'connected' ? syncIfDue() : undefined))
      })
      const stopTimer = every(() => void tick(), CHECK_EVERY_MS)
      if (optedIn()) {
        spotify.connect()
        void check().then((phase) => (phase === 'connected' ? syncIfDue() : undefined))
      } else {
        // The app's own login may outlive the account: Settings offers to log out of it.
        void askKept()
      }
      return () => {
        stopChoice()
        stopServices()
        stopTimer()
        stopWaiting()
        void stopSync()
      }
    },
  }
}
