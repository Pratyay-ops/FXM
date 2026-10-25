/**
 * What this device remembers about sync, in `localStorage` (`fxm.sync.v1`): the GitHub token,
 * the account and gist it syncs with, whether it syncs by itself, when it last synced, a
 * problem that needs the user, and notices about kept playlists.
 *
 * The token stays on this device. It never goes into the library database, a backup or the
 * gist, and FXM sends it only to GitHub. Turning sync off forgets it.
 *
 * @module
 */

import { type EntityId, isEntityId } from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'
import type { SyncErrorCode, SyncReport } from './engine'
import { normalizeToken } from './github'

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const SYNC_STORAGE_KEY = 'fxm.sync.v1'
const SYNC_STORE_VERSION = 1

/** Most notices kept. */
const MAX_NOTICES = 50

/** A sync failure that is shown until a sync succeeds. */
export interface SyncProblem {
  code: SyncErrorCode
  /** For `too-large`: what doesn't fit. */
  detail?: string
  /** When it happened, as epoch milliseconds. */
  at: number
  /** For `rate-limited`: when GitHub allows the next try. */
  retryAt?: number
}

/** A playlist a sync kept although one side had deleted it (see `MergeNotice`). */
export interface SyncNotice {
  id: string
  kind: 'kept-here' | 'restored'
  playlistId: EntityId<'playlist'>
  name: string
  at: number
}

/** What is persisted. */
export interface SyncConfig {
  /** The user's GitHub token. */
  token?: string | undefined
  /** The token's GitHub login. */
  login?: string | undefined
  /** The sync gist. */
  gistId?: string | undefined
  /** The sync gist's page. */
  gistUrl?: string | undefined
  /** Whether this device syncs by itself (after changes, on return, every 15 minutes). */
  auto: boolean
  /** When the last sync succeeded. */
  lastSyncAt?: number | undefined
  /** The size of the gist's library after the last sync, in bytes. */
  gistBytes?: number | undefined
  problem?: SyncProblem | undefined
  notices: SyncNotice[]
}

export interface SyncState extends SyncConfig {
  /** Whether a sync is running in this tab. */
  syncing: boolean
  /** Turns sync on with this token, account and gist. */
  connect(input: { token: string; login: string; gistId: string; gistUrl: string }): void
  /** Replaces the token, e.g. after the old one expired. */
  replaceToken(token: string): void
  /** Turns sync off on this device: forgets the token, the gist and the notices. */
  disconnect(): void
  setAuto(auto: boolean): void
  /** A sync started in this tab. */
  started(): void
  /** A sync ended without anything to report (cancelled, or nothing changed). */
  idle(): void
  /** A sync succeeded. */
  succeeded(report: SyncReport, at: number): void
  /** A sync failed. */
  failed(problem: SyncProblem): void
  dismissNotice(id: string): void
}

export const DEFAULT_SYNC_CONFIG: Readonly<SyncConfig> = { auto: true, notices: [] }

const ERROR_CODES: readonly SyncErrorCode[] = [
  'unauthorized',
  'forbidden',
  'gone',
  'not-owner',
  'not-sync-gist',
  'too-new',
  'corrupt',
  'too-large',
  'rate-limited',
  'network',
  'busy',
  'failed',
]

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function sanitizeProblem(value: unknown): SyncProblem | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const stored = value as Partial<Record<keyof SyncProblem, unknown>>
  const code = ERROR_CODES.find((known) => known === stored.code)
  if (code === undefined || !isTime(stored.at)) return undefined
  const problem: SyncProblem = { code, at: stored.at }
  if (typeof stored.detail === 'string') problem.detail = stored.detail.slice(0, 200)
  if (isTime(stored.retryAt)) problem.retryAt = stored.retryAt
  return problem
}

function sanitizeNotice(value: unknown): SyncNotice | null {
  if (typeof value !== 'object' || value === null) return null
  const stored = value as Partial<Record<keyof SyncNotice, unknown>>
  if (
    typeof stored.id !== 'string' ||
    (stored.kind !== 'kept-here' && stored.kind !== 'restored') ||
    !isEntityId(stored.playlistId, 'playlist') ||
    typeof stored.name !== 'string' ||
    !isTime(stored.at)
  ) {
    return null
  }
  return {
    id: stored.id,
    kind: stored.kind,
    playlistId: stored.playlistId,
    name: stored.name.slice(0, 200),
    at: stored.at,
  }
}

/** Keeps the valid fields of a stored config. Sync stays off without a whole connection. */
export function sanitizeSyncConfig(value: unknown): SyncConfig {
  const stored: Partial<Record<keyof SyncConfig, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  const config: SyncConfig = {
    auto: typeof stored.auto === 'boolean' ? stored.auto : DEFAULT_SYNC_CONFIG.auto,
    notices: Array.isArray(stored.notices)
      ? stored.notices
          .map(sanitizeNotice)
          .filter((notice) => notice !== null)
          .slice(0, MAX_NOTICES)
      : [],
  }
  const token = typeof stored.token === 'string' ? normalizeToken(stored.token) : null
  const login =
    typeof stored.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(stored.login)
      ? stored.login
      : undefined
  const gistId =
    typeof stored.gistId === 'string' && /^([0-9a-f]{20,40}|\d{1,12})$/.test(stored.gistId)
      ? stored.gistId
      : undefined
  if (token !== null && login !== undefined && gistId !== undefined) {
    config.token = token
    config.login = login
    config.gistId = gistId
    if (
      typeof stored.gistUrl === 'string' &&
      stored.gistUrl.startsWith('https://gist.github.com/')
    ) {
      config.gistUrl = stored.gistUrl
    }
  }
  if (isTime(stored.lastSyncAt)) config.lastSyncAt = stored.lastSyncAt
  if (isTime(stored.gistBytes)) config.gistBytes = stored.gistBytes
  const problem = sanitizeProblem(stored.problem)
  if (problem !== undefined) config.problem = problem
  return config
}

function persisted(state: SyncConfig): SyncConfig {
  const config: SyncConfig = { auto: state.auto, notices: state.notices }
  if (state.token !== undefined) config.token = state.token
  if (state.login !== undefined) config.login = state.login
  if (state.gistId !== undefined) config.gistId = state.gistId
  if (state.gistUrl !== undefined) config.gistUrl = state.gistUrl
  if (state.lastSyncAt !== undefined) config.lastSyncAt = state.lastSyncAt
  if (state.gistBytes !== undefined) config.gistBytes = state.gistBytes
  if (state.problem !== undefined) config.problem = state.problem
  return config
}

/** Creates a sync store persisted to Web Storage (one per app; tests make their own). */
export function createSyncStore({ storage }: { storage?: () => Storage | undefined } = {}) {
  return create<SyncState>()(
    persist(
      (set) => ({
        ...DEFAULT_SYNC_CONFIG,
        syncing: false,
        connect: ({ token, login, gistId, gistUrl }) =>
          set({
            token,
            login,
            gistId,
            gistUrl,
            problem: undefined,
            notices: [],
          }),
        replaceToken: (token) => set({ token, problem: undefined }),
        disconnect: () =>
          set({
            token: undefined,
            login: undefined,
            gistId: undefined,
            gistUrl: undefined,
            lastSyncAt: undefined,
            gistBytes: undefined,
            problem: undefined,
            notices: [],
            syncing: false,
          }),
        setAuto: (auto) => set({ auto }),
        started: () => set({ syncing: true }),
        idle: () => set({ syncing: false }),
        succeeded: (report, at) =>
          set((state) => {
            const notices = [
              ...report.notices.map(
                (notice, index): SyncNotice => ({
                  id: `${at}-${index}-${notice.playlistId}`,
                  kind: notice.kind,
                  playlistId: notice.playlistId,
                  name: notice.name,
                  at,
                }),
              ),
              ...state.notices,
            ].slice(0, MAX_NOTICES)
            return {
              syncing: false,
              lastSyncAt: at,
              gistBytes: report.bytes,
              problem: undefined,
              gistUrl: report.gistUrl,
              notices,
            }
          }),
        failed: (problem) => set({ syncing: false, problem }),
        dismissNotice: (id) =>
          set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
      }),
      {
        name: SYNC_STORAGE_KEY,
        version: SYNC_STORE_VERSION,
        storage: createSafeStorage<SyncConfig>(storage),
        partialize: (state) => persisted(state),
        migrate: (stored) => sanitizeSyncConfig(stored),
        merge: (stored, current) => ({ ...current, ...sanitizeSyncConfig(stored) }),
      },
    ),
  )
}

export type SyncStore = ReturnType<typeof createSyncStore>

export const useSyncStore: SyncStore = createSyncStore()

/** Failures only the user can fix: automatic sync stops until they do. */
const NEEDS_USER: ReadonlySet<SyncErrorCode> = new Set([
  'unauthorized',
  'forbidden',
  'gone',
  'not-owner',
  'not-sync-gist',
  'too-new',
  'corrupt',
  'too-large',
])

/** Whether only the user can fix a failure with this code. */
export function needsUser(code: SyncErrorCode): boolean {
  return NEEDS_USER.has(code)
}

/** Whether sync is set up on this device. */
export function isConnected(state: SyncConfig): boolean {
  return state.token !== undefined && state.login !== undefined && state.gistId !== undefined
}

/**
 * Re-reads the sync config when another tab changes it (a new token, sync turned off), so
 * every tab acts on the same one. Returns the unsubscribe function.
 */
export function syncConfigAcrossTabs(store: SyncStore = useSyncStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SYNC_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
