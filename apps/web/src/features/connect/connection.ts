/**
 * What the app knows about its connection to music services: the tier, FXM Connect's state, the
 * Lite self-test and the request budget, kept current from `@fxm/platform` in one store that
 * the onboarding page, the shell's notices and Settings → Diagnostics read.
 *
 * `startConnectDetection()` (from `main.tsx`) creates the app's platform and binds it; tests bind
 * their own with `bindPlatform()` and call `resetConnection()` afterwards.
 *
 * @module
 */

import type { CatalogMode, NetworkCapabilities, Platform, ProviderContext } from '@fxm/core'
import {
  type BudgetSnapshot,
  type ConnectStatus,
  type Environment,
  type FxmPlatform,
  hasConnectFeature,
  type KillSwitches,
} from '@fxm/platform'
import { create } from 'zustand'

/** The parts of `FxmPlatform` this feature uses. */
export type ConnectPlatform = Pick<
  FxmPlatform,
  'environment' | 'platform' | 'capabilities' | 'connect' | 'lite' | 'budget' | 'context'
>

/**
 * Where the Lite tier stands:
 *
 * - `not-needed`: full access (FXM Connect or the app) makes Lite unnecessary;
 * - `unavailable`: there is no Lite tier here (not a browser, or no sandbox documents);
 * - `switched-off`: the remote kill switch is on;
 * - `checking`: the self-test is running;
 * - `passed` / `failed`: what the self-test found.
 */
export type LiteStatus =
  | 'not-needed'
  | 'unavailable'
  | 'switched-off'
  | 'checking'
  | 'passed'
  | 'failed'

/**
 * - `idle`: nothing started detection (tests that bind nothing);
 * - `detecting`: the platform is being created and its first detection runs;
 * - `ready`: a platform is bound;
 * - `failed`: the platform couldn't be created.
 */
export type ConnectionPhase = 'idle' | 'detecting' | 'ready' | 'failed'

/** The connection's state. */
export interface ConnectionState {
  readonly phase: ConnectionPhase
  /** Where FXM runs, once known. */
  readonly environment?: Environment
  /** The app, as providers see it. */
  readonly platform: Platform
  /** What the platform reaches. */
  readonly capabilities: NetworkCapabilities
  /** What FXM Connect detection found, in a browser. */
  readonly connect?: ConnectStatus
  /** Where the Lite tier stands. */
  readonly lite: LiteStatus
  /** The request budget's state. */
  readonly budget?: BudgetSnapshot
  /** Whether a re-check from Diagnostics runs. */
  readonly rechecking: boolean
  /** Why the platform couldn't be created, for `failed`. */
  readonly error?: string
}

/** Before detection: a web page that has found nothing yet. */
export const INITIAL_CONNECTION: ConnectionState = {
  phase: 'idle',
  platform: 'web',
  capabilities: { youtube: 'none', mediaBytes: false, spotify: 'unreachable', fileSystem: false },
  lite: 'unavailable',
  rechecking: false,
}

/** The app's connection store. Components read it with selectors. */
export const useConnection = create<ConnectionState>()(() => INITIAL_CONNECTION)

interface Binding {
  readonly platform: ConnectPlatform
  readonly killSwitches: () => KillSwitches
  /** The Connect state the Lite check last ran for. */
  checkedFor?: string
  checking: boolean
  readonly stop: () => void
}

let binding: Binding | undefined

function connectKey(status: ConnectStatus | undefined): string {
  return status === undefined
    ? 'unknown'
    : `${status.state}:${status.version ?? status.lastSeenVersion ?? ''}:${status.features.join(',')}`
}

function liteStatus(current: Binding): LiteStatus {
  const { platform } = current
  if (platform.capabilities.current.youtube === 'full') return 'not-needed'
  if (platform.lite === undefined) return 'unavailable'
  if (current.killSwitches().lite === true) return 'switched-off'
  if (current.checking) return 'checking'
  return platform.lite.ready ? 'passed' : 'failed'
}

/** Writes the bound platform's state into the store. */
function publish(current: Binding): void {
  if (binding !== current) return
  const { platform } = current
  const connect = platform.connect?.status
  useConnection.setState({
    phase: 'ready',
    environment: platform.environment,
    platform: platform.platform,
    capabilities: platform.capabilities.current,
    lite: liteStatus(current),
    budget: platform.budget.snapshot(),
    ...(connect === undefined ? {} : { connect }),
  })
}

/**
 * Runs the Lite self-test once per FXM Connect state when FXM Connect gives no full access, so
 * the store can say `checking` meanwhile. The self-test itself runs once per session: later
 * calls share the running one or answer from its result.
 */
function checkLite(current: Binding): void {
  const { platform } = current
  const lite = platform.lite
  if (lite === undefined || platform.capabilities.current.youtube === 'full') return
  if (current.killSwitches().lite === true) return
  const key = connectKey(platform.connect?.status)
  if (current.checkedFor === key) return
  current.checkedFor = key
  current.checking = true
  publish(current)
  void lite
    .check()
    .catch(() => false)
    .finally(() => {
      current.checking = false
      publish(current)
    })
}

/** Options for {@link bindPlatform}. */
export interface BindOptions {
  /** The remote kill switches, as given to `createPlatform`. Default: none. */
  readonly killSwitches?: () => KillSwitches
}

/**
 * Makes the store follow `platform`: its capabilities, FXM Connect, the Lite tier and the
 * budget. Replaces any platform bound before. Returns a function that unbinds it.
 */
export function bindPlatform(platform: ConnectPlatform, options: BindOptions = {}): () => void {
  binding?.stop()
  const unsubscribes: (() => void)[] = []
  const current: Binding = {
    platform,
    killSwitches: options.killSwitches ?? (() => ({})),
    checking: false,
    stop: () => {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
      if (binding === current) binding = undefined
    },
  }
  binding = current
  const update = () => {
    publish(current)
    checkLite(current)
  }
  unsubscribes.push(platform.capabilities.subscribe(update))
  unsubscribes.push(platform.budget.subscribe(() => publish(current)))
  const unsubscribeConnect = platform.connect?.subscribe(update)
  if (unsubscribeConnect !== undefined) unsubscribes.push(unsubscribeConnect)
  update()
  return current.stop
}

/** Forgets the bound platform and returns the store to its initial state (tests). */
export function resetConnection(): void {
  binding?.stop()
  binding = undefined
  started = undefined
  useConnection.setState(INITIAL_CONNECTION, true)
}

/**
 * Detects again, from Settings → Diagnostics: pings FXM Connect, re-runs the Lite self-test when
 * FXM Connect gives no full access (one budget slot), and re-evaluates the capabilities.
 */
export async function recheckConnection(): Promise<void> {
  const current = binding
  if (current === undefined || useConnection.getState().rechecking) return
  const { platform } = current
  useConnection.setState({ rechecking: true })
  try {
    const status = await platform.connect?.detect().catch(() => undefined)
    const fullAccess = platform.platform !== 'web' || hasConnectFeature(status, 'youtube')
    if (platform.lite !== undefined && !fullAccess && current.killSwitches().lite !== true) {
      current.checking = true
      current.checkedFor = connectKey(status)
      publish(current)
      await platform.lite.check({ force: true }).catch(() => false)
      current.checking = false
    }
    await platform.capabilities.refresh().catch(() => undefined)
  } finally {
    current.checking = false
    if (binding === current) {
      publish(current)
      useConnection.setState({ rechecking: false })
    }
  }
}

/**
 * Forgets that FXM Connect was seen in this browser, after the user said they removed it on
 * purpose: "missing" becomes "absent", and its notice goes away.
 */
export function forgetConnect(): void {
  binding?.platform.connect?.forget()
}

/** A provider context from the bound platform, or `undefined` before one is bound. */
export function connectionContext(mode: CatalogMode): ProviderContext | undefined {
  return binding?.platform.context({ mode, priority: 'interactive' })
}

let started: Promise<void> | undefined

/**
 * Creates the platform with `create` (the app's, from `main.tsx`) and binds it. Runs once:
 * later calls return the first call's promise. Never rejects: a failure ends in phase `failed`.
 */
export function startConnectDetection(
  create: () => Promise<ConnectPlatform>,
  options: BindOptions = {},
): Promise<void> {
  started ??= (async () => {
    useConnection.setState({ phase: 'detecting' })
    try {
      bindPlatform(await create(), options)
    } catch (error) {
      useConnection.setState({
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })()
  return started
}
