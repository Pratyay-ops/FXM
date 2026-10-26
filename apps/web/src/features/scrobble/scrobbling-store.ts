/**
 * The accounts the user connected for scrobbling, kept on this device only: in `localStorage`
 * under its own key, which library backups don't read, so a backup file never carries a token
 * or a secret. Nothing is connected until the user connects it: scrobbling is opt-in.
 *
 * @module
 */

import type { ScrobbleServiceId } from '@fxm/sources/scrobble'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

// The app's first chunk loads this module (see start-scrobbling.ts), so it checks credentials
// with its own patterns, the same as `isListenBrainzToken` and `isLastfmKey` of
// `@fxm/sources/scrobble` (a test keeps them equal), instead of loading the scrobble clients.

/** A ListenBrainz user token: 8 to 128 visible ASCII characters, no spaces. */
function isListenBrainzToken(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{8,128}$/u.test(value)
}

/** A Last.fm API key or shared secret: 32 hexadecimal digits. */
function isLastfmKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/iu.test(value)
}

/** A connected ListenBrainz account. */
export interface ListenBrainzAccount {
  /** The user token, pasted from the ListenBrainz settings. */
  token: string
  /** The user's name, as ListenBrainz gave it for the token. */
  userName: string
  /** When ListenBrainz refused the token, as epoch milliseconds: sending waits for a new one. */
  refusedAt?: number
}

/** A connected Last.fm account. */
export interface LastfmAccount {
  /** The user's own API account's key. */
  apiKey: string
  /** That API account's shared secret, which signs every call. Never sent. */
  secret: string
  /** The session key Last.fm gave once the user allowed the API account. */
  sessionKey: string
  /** The user's Last.fm name. */
  userName: string
  /** When Last.fm refused the session or the key, as epoch milliseconds. */
  refusedAt?: number
}

/** The persisted part: one optional account per service. */
export interface ScrobblingAccounts {
  listenbrainz?: ListenBrainzAccount
  lastfm?: LastfmAccount
}

export interface ScrobblingState extends ScrobblingAccounts {
  /** Connects ListenBrainz with a token it accepted, replacing any account before it. */
  connectListenBrainz: (account: Omit<ListenBrainzAccount, 'refusedAt'>) => void
  /** Connects Last.fm with a session it gave, replacing any account before it. */
  connectLastfm: (account: Omit<LastfmAccount, 'refusedAt'>) => void
  /** Forgets a service's account. */
  disconnect: (service: ScrobbleServiceId) => void
  /**
   * Marks a service's account as refused, at `at`, when `credential` (the ListenBrainz token or
   * the Last.fm session key) is still the one connected; a newer one stays untouched.
   */
  markRefused: (service: ScrobbleServiceId, credential: string, at: number) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const SCROBBLING_STORAGE_KEY = 'fxm.scrobbling.v1'
const SCROBBLING_VERSION = 1

/** A name as stored: a non-empty string of at most 200 characters. */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The ListenBrainz account in `value`, when it is a valid one. */
function sanitizeListenBrainz(value: unknown): ListenBrainzAccount | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { token, userName, refusedAt } = value as Record<string, unknown>
  if (!isListenBrainzToken(token) || !isName(userName)) return undefined
  const account: ListenBrainzAccount = { token, userName }
  if (isTime(refusedAt)) account.refusedAt = refusedAt
  return account
}

/** A Last.fm session key as stored: visible ASCII, at most 128 characters. */
function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,128}$/u.test(value)
}

/** The Last.fm account in `value`, when it is a valid one. */
function sanitizeLastfm(value: unknown): LastfmAccount | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { apiKey, secret, sessionKey, userName, refusedAt } = value as Record<string, unknown>
  if (!isLastfmKey(apiKey) || !isLastfmKey(secret)) return undefined
  if (!isSessionKey(sessionKey) || !isName(userName)) return undefined
  const account: LastfmAccount = { apiKey, secret, sessionKey, userName }
  if (isTime(refusedAt)) account.refusedAt = refusedAt
  return account
}

/** Keeps the valid accounts of stored data, and drops anything else. */
export function sanitizeScrobblingAccounts(value: unknown): ScrobblingAccounts {
  const stored: Record<string, unknown> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const accounts: ScrobblingAccounts = {}
  const listenbrainz = sanitizeListenBrainz(stored.listenbrainz)
  if (listenbrainz !== undefined) accounts.listenbrainz = listenbrainz
  const lastfm = sanitizeLastfm(stored.lastfm)
  if (lastfm !== undefined) accounts.lastfm = lastfm
  return accounts
}

/** Whether any account is connected, refused or not. */
export function hasAccounts(accounts: ScrobblingAccounts): boolean {
  return accounts.listenbrainz !== undefined || accounts.lastfm !== undefined
}

/** The credential that identifies a service's account: the token, or the session key. */
export function credentialOf(
  accounts: ScrobblingAccounts,
  service: ScrobbleServiceId,
): string | undefined {
  return service === 'listenbrainz' ? accounts.listenbrainz?.token : accounts.lastfm?.sessionKey
}

export interface ScrobblingStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the scrobbling store, persisted to Web Storage (one per app; tests make their own). */
export function createScrobblingStore({ storage }: ScrobblingStoreOptions = {}) {
  return create<ScrobblingState>()(
    persist(
      (set) => ({
        connectListenBrainz: ({ token, userName }) => set({ listenbrainz: { token, userName } }),
        connectLastfm: ({ apiKey, secret, sessionKey, userName }) =>
          set({ lastfm: { apiKey, secret, sessionKey, userName } }),
        disconnect: (service) =>
          set((state) => {
            const { [service]: _gone, ...rest } = state
            return rest
          }, true),
        markRefused: (service, credential, at) =>
          set((state) => {
            const account = state[service]
            if (account === undefined || credentialOf(state, service) !== credential) return state
            return { [service]: { ...account, refusedAt: at } }
          }),
      }),
      {
        name: SCROBBLING_STORAGE_KEY,
        version: SCROBBLING_VERSION,
        storage: createSafeStorage<ScrobblingAccounts>(storage),
        partialize: ({ listenbrainz, lastfm }) => {
          const accounts: ScrobblingAccounts = {}
          if (listenbrainz !== undefined) accounts.listenbrainz = listenbrainz
          if (lastfm !== undefined) accounts.lastfm = lastfm
          return accounts
        },
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeScrobblingAccounts(persisted),
        merge: (persisted, current) => {
          const { listenbrainz: _l, lastfm: _f, ...actions } = current
          return { ...actions, ...sanitizeScrobblingAccounts(persisted) }
        },
      },
    ),
  )
}

export type ScrobblingStore = ReturnType<typeof createScrobblingStore>

export const useScrobblingStore: ScrobblingStore = createScrobblingStore()

/**
 * Re-reads the accounts when another tab changes them, so tabs agree on what is connected and
 * never write back an account the other tab replaced. Returns the unsubscribe function.
 */
export function syncScrobblingAcrossTabs(store: ScrobblingStore = useScrobblingStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SCROBBLING_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
