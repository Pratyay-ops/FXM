/**
 * How the Settings section reaches the feature: the user's choice, the runtime (built on first
 * use), the library the sync writes, and library sync's settings (stage 8.4), which decide
 * whether the copies also go to the user's sync gist. The app's by default; tests pass their own.
 *
 * @module
 */

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { getLibrary } from '../../db/repo'
import { type SyncStore, useSyncStore } from '../sync/sync-store'
import type { AccountChoiceStore } from './account-store'
import type { AccountRuntime, AccountRuntimeState } from './runtime'
import { appAccountChoice, currentAppAccountRuntime, getAppAccountRuntime } from './start'
import type { SyncLibrary } from './sync'

/** What the Settings section uses. */
export interface AccountAccess {
  /** The user's choice. */
  readonly choice: AccountChoiceStore
  /** The runtime, built on first use. */
  load(): Promise<AccountRuntime>
  /** The runtime when it is built already. */
  current(): AccountRuntime | undefined
  /** The library the sync writes, for what it synced. */
  library(): SyncLibrary
  /**
   * Library sync's settings: while it is on, the copies, like every playlist, also go to the
   * user's sync gist on GitHub, and the notices say so.
   */
  readonly librarySync: SyncStore
}

const APP_ACCESS: AccountAccess = {
  choice: appAccountChoice,
  load: getAppAccountRuntime,
  current: currentAppAccountRuntime,
  library: getLibrary,
  librarySync: useSyncStore,
}

const AccountContext = createContext<AccountAccess>(APP_ACCESS)

/** Gives the components below other access (tests). */
export function SpotifyAccountProvider({
  access,
  children,
}: {
  access: AccountAccess
  children: ReactNode
}) {
  return <AccountContext value={access}>{children}</AccountContext>
}

/** The access in use here. */
export function useAccountAccess(): AccountAccess {
  return useContext(AccountContext)
}

const IDLE: AccountRuntimeState = { phase: 'off', syncing: false, syncingElsewhere: false }

/**
 * The runtime and its state: built once the account is connected (or `build` asks), else
 * `undefined` and the idle state, so Settings loads nothing for a user who never connects.
 */
export function useAccountRuntime(build: boolean): {
  runtime: AccountRuntime | undefined
  state: AccountRuntimeState
  error: unknown
} {
  const access = useAccountAccess()
  const [runtime, setRuntime] = useState(() => access.current())
  const [error, setError] = useState<unknown>(undefined)
  useEffect(() => {
    if (runtime !== undefined || !build) return
    let live = true
    access.load().then(
      (loaded) => {
        if (live) setRuntime(loaded)
      },
      (failure: unknown) => {
        if (live) setError(failure)
      },
    )
    return () => {
      live = false
    }
  }, [access, build, runtime])
  const state = useStore(runtime?.store ?? IDLE_STORE, (current) => current)
  return { runtime, state: runtime === undefined ? IDLE : state, error }
}

/** A store that never changes, for before the runtime exists. */
const IDLE_STORE = {
  getState: () => IDLE,
  getInitialState: () => IDLE,
  setState: () => {},
  subscribe: () => () => {},
} as unknown as AccountRuntime['store']
