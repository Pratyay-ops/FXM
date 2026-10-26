/**
 * The account feature at run time: whether the account can be used here and is logged in, the
 * sync (when it runs, one tab at a time), Connect and Disconnect, and Home's Spotify sections.
 * One runtime per app (`start.ts`); tests make their own over fake services.
 *
 * - **Opt-in.** Nothing happens until the user connects the account after its notice. The
 *   choice is persisted (`account-store.ts`) and followed by every open tab: a Disconnect in one
 *   tab stops the account in all of them.
 * - **Tokens** never pass through here: the provider keeps them in memory and asks FXM Connect's
 *   bridge for them (or the desktop and Android logins later). Disconnect makes it forget them.
 * - **When it syncs:** right after Connect, when the app opens and the last sync is older than
 *   {@link SYNC_EVERY_MS}, every so often while it stays open, and on "Sync now". One tab syncs
 *   at a time (a Web Lock); the others see the result in the library. A login check that failed
 *   (the network, FXM Connect answering too late) is tried again on the same schedule, so a
 *   passing failure when the app opens doesn't stop the sync until the user notices.
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
import { isSpotifyError } from '@fxm/sources/spotify'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { LibraryError } from '../../db/repo'
import type { AccountChoiceStore } from './account-store'
import { HOME_FRESH_MS, HOME_KEEP_MS, readHome } from './home'
import { accountKeyOf } from './ids'
import type { SpotifyAccountServices } from './services'
import { readState } from './state'
import { type ForgetResult, forgetSync, runSpotifySync, type SyncProgress, writeHome } from './sync'

/** How old the last sync may get before the app syncs again by itself. */
export const SYNC_EVERY_MS = 6 * 60 * 60_000

/**
 * How often an open app checks whether a sync is due, and checks the login again after a check
 * that failed.
 */
export const CHECK_EVERY_MS = 30 * 60_000

/** The pause between two of a sync's requests to Spotify: about one a second, as imports do. */
export const SYNC_PACE_MS = 1000

/** The Web Lock one sync holds, so that two tabs never sync at once. */
export const SYNC_LOCK = 'fxm-spotify-account-sync'

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
 * - `unsupported`: this app has no Spotify login yet (desktop and Android: stages 7.4 and 6.5)
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
  /** Whether another tab was syncing when this one wanted to. */
  readonly syncingElsewhere: boolean
  /** Why this tab's last sync failed, until the next one. */
  readonly failure?: SyncFailure
}

/** Web Locks, as far as the runtime uses them. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

/** How long Disconnect waits for another tab's sync to stop before it goes on regardless. */
export const DISCONNECT_WAIT_MS = 10_000

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
   */
  connect(): Promise<void>
  /**
   * Disconnects: the opt-in goes off, the provider forgets the account's token at once, a
   * running sync stops, and the sync's state and the personal home are forgotten. The copies
   * stay, unless `removeCopies` (then those nobody changed go; see `forgetSync`).
   */
  disconnect(options?: { removeCopies?: boolean }): Promise<ForgetResult>
  /** Asks again whether the login works ("Try again"), and starts a sync when one is due. */
  recheck(): Promise<void>
  /** Syncs now, unless another tab does. Resolves when the sync ends (a running one's too). */
  syncNow(): Promise<void>
  /** Resolves once no login check and no sync is in flight. */
  whenIdle(): Promise<void>
  /** Starts following the opt-in, the capabilities and the clock. Returns a function to stop. */
  start(): () => void
}

const INITIAL: AccountRuntimeState = { phase: 'off', syncing: false, syncingElsewhere: false }

function browserLocks(): LockManagerLike | undefined {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
  return typeof locks?.request === 'function' ? locks : undefined
}

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
  /** Whether this runtime changes the choice itself, so it doesn't follow its own change. */
  let ownChange = false

  const optedIn = () => choice.getState().optedIn

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

  async function lastSyncAt(): Promise<number | undefined> {
    try {
      return (await readState(library)).meta?.lastSyncAt
    } catch {
      return undefined
    }
  }

  async function syncIfDue(): Promise<void> {
    if (store.getState().phase !== 'connected' || running) return
    const last = await lastSyncAt()
    const { failure } = store.getState()
    if (failure?.retryAt !== undefined && failure.retryAt > now()) return
    if (last === undefined || now() - last >= SYNC_EVERY_MS) await syncNow()
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
    set({ syncing: true, syncingElsewhere: false, progress: { step: 'account' } })
    try {
      const result = await runSpotifySync(spotify, library, {
        context: () => services.context('bulk'),
        signal,
        pace,
        now,
        onProgress: (progress) => set({ progress }),
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
      if (signal.aborted) return
      const phase = phaseOfError(error)
      if (phase !== undefined) set({ phase })
      else set({ failure: failureOfError(error, now()) })
    } finally {
      update({ syncing: false }, ['progress'])
    }
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
      if (!ran) set({ syncingElsewhere: true })
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
      spotify.disconnect()
      void stopSync()
      update({ phase: 'off', syncing: false, syncingElsewhere: false }, ['failure', 'progress'])
    }
  }

  const forHome: AccountForHome = {
    async status(ctx) {
      if (!optedIn()) return { connected: false }
      return spotify.status(services.context('interactive', ctx.signal))
    },
    async sections(ctx) {
      if (!optedIn()) return []
      const [state, kept] = await Promise.all([readState(library), readHome(library)])
      const account = state.meta?.account
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
        if (
          account !== undefined &&
          profile.username !== undefined &&
          (await accountKeyOf(profile.username)) === account
        ) {
          await writeHome(library, { account, at: now(), shelves })
        }
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
      // The first sync goes on in the background: Disconnect stays possible meanwhile.
      if ((await check()) === 'connected') void syncNow()
    },
    async disconnect({ removeCopies = false } = {}) {
      ownChange = true
      try {
        choice.getState().setOptedIn(false)
      } finally {
        ownChange = false
      }
      spotify.disconnect()
      await stopSync()
      update({ phase: 'off', syncing: false, syncingElsewhere: false }, ['failure', 'progress'])
      const forget = () => forgetSync(library, { removeCopies })
      if (locks === undefined) return forget()
      // Another tab's sync stops as soon as it sees the choice: wait for it to let go, but not
      // forever (a tab the browser froze in the background).
      try {
        return await locks.request(
          SYNC_LOCK,
          { signal: AbortSignal.timeout(DISCONNECT_WAIT_MS) },
          forget,
        )
      } catch (error) {
        if ((error as { name?: unknown })?.name !== 'TimeoutError') throw error
        return forget()
      }
    },
    recheck,
    syncNow,
    async whenIdle() {
      for (
        let rounds = 0;
        rounds < 100 && (checking !== undefined || running !== undefined);
        rounds++
      ) {
        await checking
        await running?.done
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
      }
      return () => {
        stopChoice()
        stopServices()
        stopTimer()
        void stopSync()
      }
    },
  }
}
