/**
 * The app's side of sync: it wires the engine to the app's library, settings, sync store and
 * GitHub, runs one sync at a time across tabs, and offers what the UI does (set sync up, sync
 * now, settle a conflict, turn sync off).
 *
 * @module
 */

import type { EntityId, Fetch, JsonObject } from '@fxm/core'
import { getLibrary, type LibraryRepo } from '../../db/repo'
import {
  DEFAULT_SETTINGS,
  isCatalogMode,
  isThemePreference,
  useSettingsStore,
} from '../settings/settings-store'
import { type BaseStore, createIndexedDbBaseStore } from './base-store'
import {
  createSyncGist,
  findSyncGists,
  gistPageUrl,
  isAbort,
  readSyncGist,
  rewriteSyncGist,
  SyncError,
  type SyncReport,
  syncLibrary,
  toSyncError,
} from './engine'
import {
  createGitHubClient,
  extraScopes,
  type GistApi,
  normalizeToken,
  parseGistId,
} from './github'
import {
  keepBothVersions,
  keepOtherVersion,
  type PlaylistConflict,
  readLibrarySnapshot,
} from './library-io'
import type { RunResult, SchedulerOptions, SyncTrigger } from './scheduler'
import { hasLibraryData, type SnapshotSummary, summarizeSnapshot } from './snapshot'
import { needsUser, useSyncStore } from './sync-store'

/** What the controller takes from its surroundings, so tests can replace it. */
export interface SyncEnvironment {
  /** The `fetch` GitHub requests go through. */
  fetch: Fetch
  /** Where bases are kept. */
  bases: () => BaseStore
  /** The library. */
  repo: () => LibraryRepo
  /** The clock, as epoch milliseconds. */
  now: () => number
  /**
   * Runs `task` while no other tab syncs: with `wait`, after the other tab finishes; without,
   * not at all (`'busy'`).
   */
  lock: <T>(task: () => Promise<T>, wait: boolean) => Promise<T | 'busy'>
  /** Timings of automatic sync (see `scheduler.ts`), and how often a visible app checks. */
  schedule: Omit<SchedulerOptions, 'run'> & { intervalMs?: number }
}

let localQueue: Promise<unknown> = Promise.resolve()
let localBusy = false

/** One sync at a time in this tab, for browsers without the Web Locks API. */
function localLock<T>(task: () => Promise<T>, wait: boolean): Promise<T | 'busy'> {
  if (!wait && localBusy) return Promise.resolve('busy' as const)
  const run = localQueue.then(async () => {
    localBusy = true
    try {
      return await task()
    } finally {
      localBusy = false
    }
  })
  localQueue = run.catch(() => {})
  return run
}

/** One sync at a time across this origin's tabs, through the Web Locks API where it exists. */
function webLock<T>(task: () => Promise<T>, wait: boolean): Promise<T | 'busy'> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (locks?.request === undefined) return localLock(task, wait)
  return locks.request('fxm-library-sync', { ifAvailable: !wait }, (lock) =>
    lock === null ? ('busy' as const) : task(),
  ) as Promise<T | 'busy'>
}

let appBases: BaseStore | undefined

const defaults: SyncEnvironment = {
  // Called at use, so a page that replaces `fetch` later (tests, the platform layer) is followed.
  fetch: ((input, init) => globalThis.fetch(input, init)) as Fetch,
  bases: () => {
    appBases ??= createIndexedDbBaseStore()
    return appBases
  },
  repo: getLibrary,
  now: () => Date.now(),
  lock: webLock,
  schedule: {},
}

let environment: SyncEnvironment = defaults

/** Tests only: replaces parts of the environment until {@link resetSyncEnvironment}. */
export function setSyncEnvironment(overrides: Partial<SyncEnvironment>): void {
  environment = { ...defaults, ...overrides }
}

/** Tests only: the real environment again. */
export function resetSyncEnvironment(): void {
  environment = defaults
}

/** The timings automatic sync uses. */
export function schedulerOptions(): SyncEnvironment['schedule'] {
  return environment.schedule
}

/** The app settings sync carries: the catalog mode and the theme. */
export const appSettingsIO = {
  defaults: { ...DEFAULT_SETTINGS } as JsonObject,
  read(): JsonObject {
    const { catalogMode, theme } = useSettingsStore.getState()
    return { catalogMode, theme }
  },
  apply(settings: JsonObject): void {
    const current = useSettingsStore.getState()
    const catalogMode = isCatalogMode(settings.catalogMode)
      ? settings.catalogMode
      : current.catalogMode
    const theme = isThemePreference(settings.theme) ? settings.theme : current.theme
    if (catalogMode !== current.catalogMode || theme !== current.theme) {
      useSettingsStore.setState({ catalogMode, theme })
    }
  },
}

function client(token: string): GistApi {
  return createGitHubClient({ token, fetch: environment.fetch, now: environment.now })
}

function deps(token: string, login: string) {
  return {
    repo: environment.repo(),
    github: client(token),
    bases: environment.bases(),
    login,
    appSettings: appSettingsIO,
    now: environment.now,
  }
}

/** How a sync run ended. */
export type SyncRun =
  | { kind: 'off' }
  | { kind: 'busy' }
  | { kind: 'unchanged' }
  | { kind: 'synced'; report: SyncReport }
  | { kind: 'failed'; error: SyncError }

/** A run as the scheduler needs to know it. */
export function runResult(run: SyncRun): RunResult {
  if (run.kind !== 'failed') return { ok: true }
  const result: RunResult = { ok: false, fatal: needsUser(run.error.code) }
  if (run.error.retryAfterMs !== undefined) result.retryAfterMs = run.error.retryAfterMs
  return result
}

/**
 * Syncs now, if sync is set up. Automatic syncs skip a sync another tab is running; a manual
 * one waits for it. Records the outcome in the sync store.
 */
export async function runSync(trigger: SyncTrigger, signal?: AbortSignal): Promise<SyncRun> {
  const { token, login, gistId } = useSyncStore.getState()
  if (token === undefined || login === undefined || gistId === undefined) return { kind: 'off' }
  const outcome = await environment.lock(async (): Promise<SyncRun> => {
    // The config may have changed while this waited for the lock.
    const current = useSyncStore.getState()
    if (current.token !== token || current.gistId !== gistId) return { kind: 'off' }
    current.started()
    try {
      const report = await syncLibrary(deps(token, login), gistId, {
        skipIfUnchanged: trigger === 'change',
        // Coming back to the app or the periodic check pull; new plays wait for a push.
        pushBackground: trigger !== 'focus' && trigger !== 'interval' && trigger !== 'online',
        ...(signal === undefined ? {} : { signal }),
      })
      const after = useSyncStore.getState()
      if (after.token !== token || after.gistId !== gistId) return { kind: 'off' }
      if (report === null) {
        after.idle()
        return { kind: 'unchanged' }
      }
      after.succeeded(report, environment.now())
      return { kind: 'synced', report }
    } catch (failure) {
      const after = useSyncStore.getState()
      if (isAbort(failure)) {
        after.idle()
        return { kind: 'off' }
      }
      const error = toSyncError(failure) as SyncError
      if (after.token === token && after.gistId === gistId) {
        const at = environment.now()
        after.failed({
          code: error.code,
          at,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          ...(error.retryAfterMs === undefined ? {} : { retryAt: at + error.retryAfterMs }),
        })
      } else {
        after.idle()
      }
      return { kind: 'failed', error }
    }
  }, trigger === 'manual')
  return outcome === 'busy' ? { kind: 'busy' } : outcome
}

// --- Setting sync up -------------------------------------------------------------------------

/** Why setting sync up failed before any sync ran. */
export type ConnectErrorCode =
  /** The text can't be a GitHub token. */
  | 'token-format'
  /** A classic token with more scopes than `gist`. */
  | 'token-too-broad'
  /** The text can't be a gist link. */
  | 'gist-link'
  /** A new token belongs to another account than the sync gist. */
  | 'other-account'

/** A failure while setting sync up, with a {@link ConnectErrorCode}. */
export class ConnectError extends Error {
  override readonly name = 'ConnectError'
  readonly code: ConnectErrorCode
  /** For `token-too-broad`: the extra scopes; for `other-account`: the token's login. */
  readonly detail: string | undefined

  constructor(code: ConnectErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** What setting sync up will do, for the user to confirm. */
export interface ConnectPlan {
  token: string
  login: string
  /** The account's sync gist, when one was found or pasted. */
  gist?: { id: string; url: string; savedAt: string; summary: SnapshotSummary }
  /** What this device's library holds. */
  local: SnapshotSummary
  /** Whether this device's library holds anything of the user's. */
  localHasData: boolean
}

async function checkToken(input: string, signal?: AbortSignal) {
  const token = normalizeToken(input)
  if (token === null) throw new ConnectError('token-format', 'That is not a GitHub token')
  const github = client(token)
  let user: Awaited<ReturnType<GistApi['getUser']>>
  try {
    user = await github.getUser(signal)
  } catch (error) {
    throw toSyncError(error)
  }
  const extra = extraScopes(user)
  if (extra.length > 0) {
    throw new ConnectError('token-too-broad', 'The token can do more than sync', extra.join(', '))
  }
  return { token, github, login: user.login }
}

/**
 * Checks a token and finds the account's sync gist (or reads the pasted one), without
 * changing anything, so the user can confirm what happens next.
 */
export async function prepareConnect(
  input: { token: string; gistLink?: string },
  signal?: AbortSignal,
): Promise<ConnectPlan> {
  const { token, github, login } = await checkToken(input.token, signal)
  let gistId: string | undefined
  const link = input.gistLink?.trim() ?? ''
  if (link !== '') {
    const id = parseGistId(link)
    if (id === null) throw new ConnectError('gist-link', 'That is not a gist link')
    gistId = id
  } else {
    gistId = (await findSyncGists(github, signal === undefined ? {} : { signal }))[0]?.id
  }
  const local = await readLibrarySnapshot(environment.repo(), appSettingsIO.read())
  const plan: ConnectPlan = {
    token,
    login,
    local: summarizeSnapshot(local),
    localHasData: hasLibraryData(local),
  }
  if (gistId !== undefined) {
    const found = await readSyncGist(github, gistId, login, {
      signal,
      now: environment.now(),
    })
    plan.gist = {
      id: found.gist.id,
      url: gistPageUrl(login, found.gist.id),
      savedAt: found.manifest.savedAt,
      summary: summarizeSnapshot(found.snapshot),
    }
  }
  return plan
}

/**
 * Turns sync on as planned: joins the sync gist (merging, so nothing here is lost) or creates
 * one with this device's library. Sync is saved as on only once that first sync worked.
 */
export async function confirmConnect(plan: ConnectPlan, signal?: AbortSignal): Promise<SyncReport> {
  const run = await environment.lock(async () => {
    const report =
      plan.gist === undefined
        ? await createSyncGist(deps(plan.token, plan.login), signal)
        : await syncLibrary(
            deps(plan.token, plan.login),
            plan.gist.id,
            signal === undefined ? {} : { signal },
          )
    if (report === null) throw new SyncError('failed', 'The first sync did nothing')
    const store = useSyncStore.getState()
    store.connect({
      token: plan.token,
      login: plan.login,
      gistId: report.gistId,
      gistUrl: report.gistUrl,
    })
    useSyncStore.getState().succeeded(report, environment.now())
    return report
  }, true)
  if (run === 'busy') throw new SyncError('busy', 'Another tab is syncing')
  return run
}

/** Replaces an expired or revoked token with a new one of the same account. */
export async function replaceToken(input: string, signal?: AbortSignal): Promise<void> {
  const { token, login } = await checkToken(input, signal)
  const config = useSyncStore.getState()
  if (config.login !== undefined && config.login.toLowerCase() !== login.toLowerCase()) {
    throw new ConnectError('other-account', 'The token belongs to another account', login)
  }
  config.replaceToken(token)
}

/**
 * Rewrites the sync gist with this device's library, when it was changed outside FXM and can't
 * be read. Other devices keep their libraries and add back what this one lacks.
 */
export async function rewriteGist(signal?: AbortSignal): Promise<SyncReport> {
  const { token, login, gistId } = useSyncStore.getState()
  if (token === undefined || login === undefined || gistId === undefined) {
    throw new SyncError('failed', 'Sync is off')
  }
  const run = await environment.lock(async () => {
    const report = await rewriteSyncGist(deps(token, login), gistId, signal)
    useSyncStore.getState().succeeded(report, environment.now())
    return report
  }, true)
  if (run === 'busy') throw new SyncError('busy', 'Another tab is syncing')
  return run
}

/** Turns sync off on this device. The library and the gist stay as they are. */
export function disconnectSync(): void {
  useSyncStore.getState().disconnect()
}

// --- Conflicts -------------------------------------------------------------------------------

/** How to settle a conflict between a playlist and its other version. */
export type ConflictChoice = 'keep-this' | 'keep-other' | 'keep-both'

/** Settles a conflict. The change syncs like any other edit. */
export async function settleConflict(
  conflict: PlaylistConflict,
  choice: ConflictChoice,
): Promise<void> {
  const repo = environment.repo()
  const now = environment.now()
  if (choice === 'keep-this') await repo.deletePlaylist(conflict.copy.id)
  else if (choice === 'keep-other') await keepOtherVersion(repo, conflict.copy.id, now)
  else await keepBothVersions(repo, conflict.copy.id, { now })
}

/** Deletes a playlist a sync kept, from its notice, and dismisses the notice. */
export async function deleteKeptPlaylist(
  noticeId: string,
  playlistId: EntityId<'playlist'>,
): Promise<void> {
  const repo = environment.repo()
  if ((await repo.getPlaylistView(playlistId)) !== undefined) await repo.deletePlaylist(playlistId)
  useSyncStore.getState().dismissNotice(noticeId)
}
