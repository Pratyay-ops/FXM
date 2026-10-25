/**
 * Test helpers for the connect feature: connection states for each tier and FXM Connect state,
 * the real platform on a test page with a fake FXM Connect and a fake Lite sandbox, and a fake
 * media element for the playback probe. Never import this from app code.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import {
  type ConnectStatus,
  type ConnectWindow,
  createPlatform,
  type FxmPlatform,
  type KeyValueStorage,
  memoryStorage,
} from '@fxm/platform'
import {
  createFakeSandbox,
  type FakeConnect,
  type FakeConnectOptions,
  type FakeSandbox,
  installFakeConnect,
} from '@fxm/platform/testing'
import { Window } from 'happy-dom'
import { bindPlatform, type ConnectionState, INITIAL_CONNECTION, useConnection } from './connection'
import type { MediaElementLike, ProbeClock } from './playback-probe'
import type { Tier } from './tiers'

/** What {@link openTestPlatform} sets up. */
export interface TestPlatformSetup {
  /** A fake FXM Connect on the page when it opens. */
  readonly connect?: FakeConnectOptions
  /** Whether the Lite self-test passes. Default `false`. */
  readonly lite?: boolean
  /** Whether the Lite kill switch is on. Default `false`. */
  readonly killed?: boolean
  /** Where the platform keeps its state. Default: a new one in memory. */
  readonly storage?: KeyValueStorage
}

/** The platform {@link openTestPlatform} made, and its controls. */
export interface TestPlatform {
  readonly platform: FxmPlatform
  readonly connect: FakeConnect | undefined
  readonly sandbox: FakeSandbox
  /** Changes what the Lite self-test answers from now on. */
  setLite(passes: boolean): void
  /** Turns the Lite kill switch on or off. */
  setKilled(on: boolean): void
}

const openPages: { happyDOM: { close(): Promise<void> } }[] = []

/**
 * The real platform from `@fxm/platform` on its own happy-dom page at the FXM origin, with a fake
 * FXM Connect and a fake Lite sandbox, bound to the connection store. (In the test environment's
 * global page, a message's `event.source` is not the page's window, so FXM Connect detection
 * needs a page of its own.) Close the pages with {@link closeTestPages}.
 */
export async function openTestPlatform(setup: TestPlatformSetup = {}): Promise<TestPlatform> {
  const window = new Window({ url: 'https://fxmusic.pages.dev/app/' })
  openPages.push(window)
  const page = window as unknown as ConnectWindow
  const connect = setup.connect === undefined ? undefined : installFakeConnect(page, setup.connect)
  let litePasses = setup.lite ?? false
  let killed = setup.killed ?? false
  const sandbox = createFakeSandbox({ selfTest: () => litePasses })
  const killSwitches = () => ({ lite: killed })
  const platform = await createPlatform({
    environment: 'browser',
    window: page,
    storage: setup.storage ?? memoryStorage(),
    sandbox,
    killSwitches,
  })
  bindPlatform(platform, { killSwitches })
  return {
    platform,
    connect,
    sandbox,
    setLite: (passes) => {
      litePasses = passes
    },
    setKilled: (on) => {
      killed = on
    },
  }
}

/** A happy-dom page for a platform a test creates itself. */
export function openTestPage(): ConnectWindow {
  const window = new Window({ url: 'https://fxmusic.pages.dev/app/' })
  openPages.push(window)
  return window as unknown as ConnectWindow
}

/** Closes the pages {@link openTestPlatform} and {@link openTestPage} opened. */
export async function closeTestPages(): Promise<void> {
  await Promise.all(openPages.splice(0).map((page) => page.happyDOM.close()))
}

/** The capabilities of each tier in a browser. */
export const TIER_CAPABILITIES: Readonly<Record<Tier, NetworkCapabilities>> = {
  free: { youtube: 'none', mediaBytes: false, spotify: 'unreachable', fileSystem: false },
  lite: { youtube: 'simple', mediaBytes: false, spotify: 'unreachable', fileSystem: false },
  full: { youtube: 'full', mediaBytes: true, spotify: 'anonymous', fileSystem: false },
}

/** FXM Connect's statuses, as detection reports them. */
export const CONNECT_STATUS = {
  present: {
    state: 'present',
    version: '0.1.0',
    features: ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time'],
  },
  outdated: { state: 'outdated', version: '0.0.9', features: ['youtube'] },
  missing: { state: 'missing', features: [], lastSeenVersion: '0.1.0' },
  absent: { state: 'absent', features: [] },
} as const satisfies Record<string, ConnectStatus>

/** A connection state after detection, in a browser, Free only unless overridden. */
export function readyConnection(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    ...INITIAL_CONNECTION,
    phase: 'ready',
    environment: 'browser',
    connect: CONNECT_STATUS.absent,
    lite: 'failed',
    ...overrides,
  }
}

/** Puts a connection state into the app's store. */
export function setConnection(overrides: Partial<ConnectionState> = {}): void {
  useConnection.setState(readyConnection(overrides), true)
}

/** A clock whose time only the test moves. */
export class ManualClock implements ProbeClock {
  private time = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  private nextId = 1

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Moves time on, running the timers that come due, in order. */
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0]
      if (due === undefined) break
      const [id, timer] = due
      this.timers.delete(id)
      this.time = timer.at
      timer.callback()
    }
    this.time = end
  }
}

/** A media element that plays nothing: the test fires its events. */
export class FakeMediaElement extends EventTarget implements MediaElementLike {
  src = ''
  volume = 1
  preload = ''
  currentTime = 0
  error: { code: number } | null = null
  /** The sources `play()` was called with, in order. */
  readonly played: string[] = []
  /** How `play()` answers. */
  playAnswer: 'resolve' | 'not-allowed' | 'abort' = 'resolve'
  /** The MIME types `canPlayType` says yes to (prefixes). */
  supported: readonly string[] = ['audio/']

  play(): Promise<void> {
    this.played.push(this.src)
    if (this.playAnswer === 'resolve') return Promise.resolve()
    const error = new Error('play() refused')
    error.name = this.playAnswer === 'not-allowed' ? 'NotAllowedError' : 'AbortError'
    return Promise.reject(error)
  }

  pause(): void {}

  load(): void {}

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  canPlayType(type: string): string {
    return this.supported.some((prefix) => type.startsWith(prefix)) ? 'maybe' : ''
  }

  /** Fires a media event. */
  fire(type: string): void {
    this.dispatchEvent(new Event(type))
  }

  /** Plays on by `seconds`, as `timeupdate` reports it. */
  progress(seconds: number): void {
    this.currentTime += seconds
    this.fire('timeupdate')
  }

  /** Fails with a media error. */
  failWith(code: number): void {
    this.error = { code }
    this.fire('error')
  }
}
