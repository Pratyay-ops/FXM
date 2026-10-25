/**
 * A fake {@link SongResolver} for tests and the development fake mode, standing in for stage
 * 1.4's ladder: it answers with made-up streams, or fails the way the ladder can, and records
 * what it was asked and told.
 *
 * @module
 */

import { FxmError, type ProviderContext, type StreamOption } from '@fxm/core'
import type { PlaybackFailureReason, ResolveRungs, SelfTestSong, SongResolver } from './resolver'

/**
 * What the fake does:
 *
 * - `plays`: one stream that plays;
 * - `capped`: the top of the ladder gives a stream that fails its first request, the last
 *   resort (itag 18) one that plays;
 * - `fails`: every stream fails;
 * - `bot-check`: the resolution fails with a bot check (`BotCheck`);
 * - `unavailable`: the song can't play here (`Unavailable`).
 */
export type FakeSongScenario = 'plays' | 'capped' | 'fails' | 'bot-check' | 'unavailable'

/** Every scenario. */
export const FAKE_SONG_SCENARIOS: readonly FakeSongScenario[] = [
  'plays',
  'capped',
  'fails',
  'bot-check',
  'unavailable',
]

/** The URLs the fake's streams point at: one that plays and one that doesn't. */
export interface FakeStreamUrls {
  readonly good: string
  readonly bad: string
}

/** Options for {@link createFakeResolver}. */
export interface FakeResolverOptions {
  /** The streams' URLs. Default `fake://good` and `fake://bad`, for a fake probe. */
  readonly urls?: FakeStreamUrls
  /** Waits this long before each answer, in ms. Default 0. */
  readonly latencyMs?: number
}

/** A fake resolver that records its calls. */
export interface FakeSongResolver extends SongResolver {
  /** Every resolution, in order. */
  readonly resolutions: readonly { readonly song: SelfTestSong; readonly rungs: ResolveRungs }[]
  /** The streams reported as playing. */
  readonly successes: readonly StreamOption[]
  /** The streams reported as failed, with the reason. */
  readonly failures: readonly {
    readonly option: StreamOption
    readonly reason: PlaybackFailureReason
  }[]
}

type FakeOption = StreamOption & { readonly label: string; readonly rung: string }

/**
 * A stream as the ladder would describe it. The playing streams are WAV files, which every
 * browser decodes, so the development fake mode can really play them; the failing one claims
 * to be Opus, which the browser tries and fails to decode.
 */
function stream(
  url: string,
  ctx: ProviderContext,
  kind: 'top' | 'cut-off' | 'fallback',
): FakeOption {
  const verified = ctx.capabilities.mediaBytes ? 'verified' : 'unverified'
  if (kind === 'cut-off') {
    return {
      url,
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      bitrateKbps: 135,
      tier: 'high',
      protocol: 'progressive',
      ipBound: true,
      fullLength: 'unverified',
      label: 'Fake stream that stops early',
      rung: 'visionos',
    }
  }
  return {
    // Each resolution gives new URLs, as the ladder's do: the fallback's never repeats the top's.
    url: kind === 'fallback' ? `${url}#fallback` : url,
    codec: 'pcm',
    container: 'wav',
    media: kind === 'fallback' ? 'muxed-video' : 'audio',
    bitrateKbps: 128,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: verified,
    label: kind === 'fallback' ? 'Fake last-resort stream' : 'Fake stream',
    rung: kind === 'fallback' ? 'android-muxed' : 'visionos',
  }
}

/** Creates the fake for a scenario. */
export function createFakeResolver(
  scenario: FakeSongScenario,
  options: FakeResolverOptions = {},
): FakeSongResolver {
  const { good, bad } = options.urls ?? { good: 'fake://good', bad: 'fake://bad' }
  const latencyMs = options.latencyMs ?? 0
  const resolutions: { song: SelfTestSong; rungs: ResolveRungs }[] = []
  const successes: StreamOption[] = []
  const failures: { option: StreamOption; reason: PlaybackFailureReason }[] = []

  async function wait(signal: unknown): Promise<void> {
    if (latencyMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const abortSignal = signal as AbortSignal | undefined
      const timer = setTimeout(resolve, latencyMs)
      abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(abortSignal.reason)
        },
        { once: true },
      )
    })
  }

  return {
    hasFallback: true,
    resolutions,
    successes,
    failures,
    async resolve(song, ctx, { rungs }) {
      resolutions.push({ song, rungs })
      await wait(ctx.signal)
      switch (scenario) {
        case 'bot-check':
          throw new FxmError('BotCheck', "Fake: sign in to confirm you're not a bot")
        case 'unavailable':
          throw new FxmError('Unavailable', 'Fake: this video is not available')
        case 'plays':
          return [stream(good, ctx, rungs === 'fallback' ? 'fallback' : 'top')]
        case 'capped':
          return rungs === 'fallback'
            ? [stream(good, ctx, 'fallback')]
            : [stream(bad, ctx, 'cut-off')]
        case 'fails':
          return [stream(bad, ctx, rungs === 'fallback' ? 'fallback' : 'cut-off')]
      }
    },
    reportPlaybackSuccess(option) {
      successes.push(option)
    },
    reportPlaybackFailure(option, _ctx, reason) {
      failures.push({ option, reason })
    },
  }
}
