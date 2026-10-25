/**
 * The setup the lifecycle tests share: the real player, a fake engine, the stream lifecycle and
 * fakes for every touch-point, under Vitest's fake timers (which also drive `Date.now`). Not
 * exported from the package.
 *
 * @module
 */

import {
  type AudioCandidate,
  createSeededRandom,
  currentQueueItem,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_QUALITY_PREFS,
  type PlaybackSettings,
  type ProviderContext,
  type QualityPrefs,
  sanitizeQualityPrefs,
} from '@fxm/core'
import { vi } from 'vitest'
import { Player, type PlayerOptions } from '../player'
import type { ResolveRequest } from '../resolver'
import { FakeEngine } from '../testing/fake-engine'
import { createMemoryMatchStore, type OfflineStore, type StreamSource } from './adapters'
import {
  type LifecycleEventMap,
  StreamLifecycle,
  type StreamLifecycleOptions,
} from './stream-lifecycle'
import { FakeMatcher } from './testing/fake-matcher'
import { FakeNetworkMonitor } from './testing/fake-network'
import { FakeStreamSource } from './testing/fake-stream-source'
import { type TEST_CAPABILITIES, testContext } from './testing/fixtures'

/** The fake clock's start: 2026-10-26, midnight UTC. */
export const START = Date.UTC(2026, 9, 26)

/** Options for {@link setup}. */
export interface SetupOptions {
  /** The tier. Default: `full`. */
  tier?: keyof typeof TEST_CAPABILITIES
  /** Playback settings to change from the defaults. */
  settings?: Partial<PlaybackSettings>
  /** More sources besides the YouTube ladder. */
  sources?: StreamSource[]
  /** The Invidious source. */
  invidious?: StreamSource
  /** The offline store. */
  offline?: OfflineStore
  /** Player options. */
  player?: Partial<PlayerOptions>
  /** Lifecycle options. */
  lifecycle?: Partial<StreamLifecycleOptions>
  /** Whether to attach the player to the lifecycle. Default: true. */
  attach?: boolean
}

/** Starts the fake clock; call in `beforeEach`. */
export function useFakeClock(): void {
  vi.useFakeTimers({ now: START })
}

/** Lets pending promise chains and due timers run, `ms` into the future. */
export async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Builds the player, the lifecycle and the fakes. */
export function setup(options: SetupOptions = {}) {
  const network = new FakeNetworkMonitor()
  const youtube = new FakeStreamSource({ now: () => Date.now() })
  const matcher = new FakeMatcher()
  const matches = createMemoryMatchStore()
  const settings: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS, ...options.settings }
  let prefs: QualityPrefs = sanitizeQualityPrefs(DEFAULT_QUALITY_PREFS)
  let ctx: ProviderContext = testContext(options.tier ?? 'full')
  const lifecycle = new StreamLifecycle({
    sources: [youtube, ...(options.sources ?? [])],
    matcher,
    matches,
    context: () => ctx,
    settings: () => settings,
    qualityPrefs: () => prefs,
    network,
    now: () => Date.now(),
    ...(options.invidious === undefined ? {} : { invidious: options.invidious }),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...options.lifecycle,
  })
  const engine = new FakeEngine()
  const player = new Player({
    engine,
    resolver: lifecycle,
    random: createSeededRandom(1),
    now: () => Date.now(),
    ...options.player,
  })
  if (options.attach !== false) lifecycle.attach(player)
  const events = record(lifecycle)
  const failed: Error[] = []
  player.on('trackfailed', ({ error }) => failed.push(error))
  return {
    lifecycle,
    player,
    engine,
    youtube,
    matcher,
    matches,
    network,
    settings,
    events,
    failed,
    /** Switches the tier, e.g. when FXM Connect appears. */
    setTier(tier: keyof typeof TEST_CAPABILITIES) {
      ctx = testContext(tier, { mode: ctx.mode })
    },
    /** Changes the quality settings. */
    setPrefs(next: QualityPrefs) {
      prefs = next
    },
    /** The title of the current track. */
    current: () => currentQueueItem(player.getState().queue)?.track.title,
    /** The candidate recorded on the current queue item. */
    recorded: (): AudioCandidate | undefined =>
      currentQueueItem(player.getState().queue)?.candidate,
  }
}

/** Records the lifecycle's events, in order. */
function record(lifecycle: StreamLifecycle) {
  const seen = {
    reviews: [] as LifecycleEventMap['reviewchange'][],
    replaced: [] as LifecycleEventMap['smartreplace'][],
    flushes: [] as LifecycleEventMap['flush'][],
  }
  lifecycle.on('reviewchange', (reviews) => seen.reviews.push(reviews))
  lifecycle.on('smartreplace', (swap) => seen.replaced.push(swap))
  lifecycle.on('flush', (flush) => seen.flushes.push(flush))
  return seen
}

/** The URL of the fake ladder's stream: `https://media.test/<ref>/<itag>?n=<serial>`. */
export function ladderUrl(ref: string, itag: number, serial: number): string {
  return `https://media.test/${ref}/${itag}?n=${serial}`
}

/** A `play` request, as the player sends it, for calling the lifecycle directly. */
export function playRequest(signal: AbortSignal = new AbortController().signal): ResolveRequest {
  return { reason: 'play', attempt: 0, signal, canPlay: () => 'probably' }
}
