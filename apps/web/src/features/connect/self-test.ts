/**
 * The "resolve and play one song" self-test of Settings → Diagnostics (docs/ARCHITECTURE.md
 * §10): it resolves a known YouTube Music song through the stream resolver and plays a few
 * seconds of it, so a user can tell at a glance whether YouTube playback works here, and where
 * it breaks if not.
 *
 * It walks the ladder the way the playback policy does (stage 2.3): the best stream the browser
 * can decode, under the default Wi-Fi ceiling (`pickStream`); when its first request fails, the
 * last-resort rung (itag 18). It reports each failure to the resolver once, so a test never
 * cools a rung down more than a real failed play would. It doesn't use the player itself, so a
 * failure points at the resolver or the stream, not at the queue.
 *
 * @module
 */

import {
  CODEC_LABELS,
  DEFAULT_QUALITY_PREFS,
  type ProviderContext,
  pickStream,
  type StreamOption,
} from '@fxm/core'
import type { PlaybackProbe, ProbeOptions, ProbeResult } from './playback-probe'
import { type ResolveRungs, SELF_TEST_SONG, type SelfTestSong, type SongResolver } from './resolver'

/** Where the self-test is. */
export type SelfTestStep =
  | { readonly kind: 'resolving'; readonly rungs: ResolveRungs }
  | { readonly kind: 'playing'; readonly label: string; readonly option: StreamOption }

/** One stream the self-test tried. */
export interface SelfTestAttempt {
  /** The stream, e.g. "Opus · 135 kbps · VISIONOS". */
  readonly label: string
  /** Which resolution it came from. */
  readonly rungs: ResolveRungs
  /** The stream. */
  readonly option: StreamOption
  /** What playing it did. */
  readonly result: ProbeResult
}

/** What the self-test found. */
export type SelfTestReport =
  | {
      readonly status: 'passed'
      readonly song: SelfTestSong
      /** The stream that played. */
      readonly played: SelfTestAttempt
      /** Every stream tried, the one that played last. */
      readonly attempts: readonly SelfTestAttempt[]
      /** How long the first resolution took. */
      readonly resolveMs: number
    }
  | {
      readonly status: 'failed'
      readonly song: SelfTestSong
      /** `resolve`: the resolver failed; `play`: no stream played; `none`: nothing to play. */
      readonly stage: 'resolve' | 'play' | 'none'
      /** The resolver's error, for `resolve`. */
      readonly error?: unknown
      readonly attempts: readonly SelfTestAttempt[]
    }
  | {
      /** No YouTube access in this tier: there is nothing to test. */
      readonly status: 'skipped'
      readonly song: SelfTestSong
    }
  | { readonly status: 'cancelled'; readonly song: SelfTestSong }

/** Options for {@link runSongSelfTest}. */
export interface SelfTestOptions {
  /** The resolver: 1.4's ladder, or a fake. */
  readonly resolver: SongResolver
  /** Plays the streams. */
  readonly probe: PlaybackProbe
  /** The provider context for the resolution, with the platform's current capabilities. */
  readonly context: () => ProviderContext
  /** The song. Default {@link SELF_TEST_SONG}. */
  readonly song?: SelfTestSong
  /** Cancels the test. */
  readonly signal?: AbortSignal
  /** Hears each step, for a progress line. */
  readonly onStep?: (step: SelfTestStep) => void
  /** How long each stream may take to start, and how much must play. */
  readonly play?: Pick<ProbeOptions, 'startTimeoutMs' | 'playMs' | 'volume'>
  /** Milliseconds since some point, for timings. Default `performance.now`. */
  readonly now?: () => number
}

const RUNG_NAMES: Readonly<Record<string, string>> = {
  visionos: 'VISIONOS',
  ios: 'IOS',
  'android-vr': 'ANDROID_VR',
  'android-muxed': 'ANDROID',
}

/**
 * A stream's label for the report: stage 1.4's own `label` ("AAC from 360p video") and `rung`
 * when the option has them, else the codec, plus the bitrate.
 */
export function describeStream(option: StreamOption): string {
  const extra = option as StreamOption & { readonly label?: unknown; readonly rung?: unknown }
  const parts = [
    typeof extra.label === 'string' && extra.label !== ''
      ? extra.label
      : CODEC_LABELS[option.codec],
  ]
  if (option.bitrateKbps !== undefined && option.bitrateKbps > 0) {
    parts.push(`${Math.round(option.bitrateKbps)} kbps`)
  }
  if (typeof extra.rung === 'string' && extra.rung !== '') {
    parts.push(RUNG_NAMES[extra.rung] ?? extra.rung)
  }
  return parts.join(' · ')
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** Runs the self-test. It never rejects: every outcome is a {@link SelfTestReport}. */
export async function runSongSelfTest(options: SelfTestOptions): Promise<SelfTestReport> {
  const { resolver, probe, signal, onStep } = options
  const song = options.song ?? SELF_TEST_SONG
  const now = options.now ?? (() => performance.now())
  const ctx = options.context()
  if (ctx.capabilities.youtube === 'none') return { status: 'skipped', song }

  const attempts: SelfTestAttempt[] = []
  const tried = new Set<string>()
  let resolveMs: number | undefined
  const ladder: ResolveRungs[] = resolver.hasFallback ? ['all', 'fallback'] : ['all']

  for (const rungs of ladder) {
    if (signal?.aborted) return { status: 'cancelled', song }
    onStep?.({ kind: 'resolving', rungs })
    const startedAt = now()
    let streams: StreamOption[]
    try {
      streams = await resolver.resolve(song, ctx, { rungs })
    } catch (error) {
      if (isAbort(error, signal)) return { status: 'cancelled', song }
      // A failed fallback resolution leaves what the first one found to speak for itself.
      if (rungs === 'fallback') break
      return { status: 'failed', song, stage: 'resolve', error, attempts }
    }
    resolveMs ??= now() - startedAt
    if (signal?.aborted) return { status: 'cancelled', song }

    const fresh = streams.filter((stream) => !tried.has(stream.url))
    const option = pickStream(
      fresh.filter((stream) => probe.canPlay(stream)),
      DEFAULT_QUALITY_PREFS.streaming.wifi,
    )
    if (option === undefined) continue
    tried.add(option.url)
    const label = describeStream(option)
    onStep?.({ kind: 'playing', label, option })
    const result = await probe.play(option.url, {
      ...options.play,
      ...(signal === undefined ? {} : { signal }),
    })
    const attempt: SelfTestAttempt = { label, rungs, option, result }
    attempts.push(attempt)
    if (result.ok) {
      resolver.reportPlaybackSuccess?.(option, ctx)
      return { status: 'passed', song, played: attempt, attempts, resolveMs }
    }
    if (result.reason === 'aborted') return { status: 'cancelled', song }
    // The browser wants a tap: no other stream would fare better, and the stream is not to blame.
    if (result.reason === 'blocked') break
    resolver.reportPlaybackFailure?.(
      option,
      ctx,
      rungs === 'fallback' ? 'fallback-failed' : 'probe-failed',
    )
  }
  return { status: 'failed', song, stage: attempts.length === 0 ? 'none' : 'play', attempts }
}
