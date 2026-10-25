import type { ProviderContext, StreamOption } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createFakeResolver, type FakeSongScenario } from './fake-resolver'
import type { PlaybackProbe, ProbeResult } from './playback-probe'
import { SELF_TEST_SONG } from './resolver'
import { describeStream, runSongSelfTest, type SelfTestStep } from './self-test'
import { TIER_CAPABILITIES } from './testing'

function context(tier: 'free' | 'lite' | 'full' = 'lite'): ProviderContext {
  return {
    fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch,
    platform: 'web',
    capabilities: TIER_CAPABILITIES[tier],
    mode: 'music',
  }
}

/** A probe that plays `fake://good…` URLs and fails the others, as a media element would. */
function fakeProbe(overrides: Partial<Record<'bad' | 'good', ProbeResult>> = {}) {
  const played: string[] = []
  const probe: PlaybackProbe = {
    prime: vi.fn(),
    canPlay: () => true,
    async play(url) {
      played.push(url)
      return url.startsWith('fake://good')
        ? (overrides.good ?? { ok: true, startedAfterMs: 250, playedMs: 3000 })
        : (overrides.bad ?? {
            ok: false,
            reason: 'media-error',
            afterMs: 90,
            playedMs: 0,
            detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
          })
    },
    dispose: vi.fn(),
  }
  return { probe, played }
}

async function run(scenario: FakeSongScenario, tier: 'free' | 'lite' | 'full' = 'lite') {
  const resolver = createFakeResolver(scenario)
  const { probe, played } = fakeProbe()
  const steps: SelfTestStep[] = []
  let time = 0
  const report = await runSongSelfTest({
    resolver,
    probe,
    context: () => context(tier),
    onStep: (step) => steps.push(step),
    now: () => {
      time += 100
      return time
    },
  })
  return { report, resolver, played, steps }
}

describe('runSongSelfTest', () => {
  it('passes when the best stream plays, and tells the ladder', async () => {
    const { report, resolver, played, steps } = await run('plays')
    expect(report).toMatchObject({
      status: 'passed',
      song: SELF_TEST_SONG,
      resolveMs: 100,
      played: { label: 'Fake stream · 128 kbps · VISIONOS', rungs: 'all' },
    })
    expect(played).toEqual(['fake://good'])
    expect(resolver.resolutions).toEqual([{ song: SELF_TEST_SONG, rungs: 'all' }])
    expect(resolver.successes).toHaveLength(1)
    expect(resolver.failures).toEqual([])
    expect(steps.map((step) => step.kind)).toEqual(['resolving', 'playing'])
  })

  it('falls back to the last-resort rung when the first stream fails its first request', async () => {
    const { report, resolver, played } = await run('capped')
    expect(report.status).toBe('passed')
    if (report.status !== 'passed') return
    expect(report.attempts.map((attempt) => [attempt.rungs, attempt.result.ok])).toEqual([
      ['all', false],
      ['fallback', true],
    ])
    expect(report.played.label).toBe('Fake last-resort stream · 128 kbps · ANDROID')
    expect(played).toEqual(['fake://bad', 'fake://good#fallback'])
    expect(resolver.resolutions.map((resolution) => resolution.rungs)).toEqual(['all', 'fallback'])
    // One failure for the top rung, as one failed play would report.
    expect(resolver.failures).toEqual([
      { option: report.attempts[0]?.option, reason: 'probe-failed' },
    ])
  })

  it('fails when no stream plays, reporting each rung once', async () => {
    const { report, resolver } = await run('fails')
    expect(report).toMatchObject({ status: 'failed', stage: 'play' })
    expect(resolver.failures.map((failure) => failure.reason)).toEqual([
      'probe-failed',
      'fallback-failed',
    ])
  })

  it.each([
    ['bot-check', 'BotCheck'],
    ['unavailable', 'Unavailable'],
  ] as const)('fails at the resolution for %s', async (scenario, code) => {
    const { report, played } = await run(scenario)
    expect(report).toMatchObject({ status: 'failed', stage: 'resolve', error: { code } })
    expect(played).toEqual([])
  })

  it('skips the test without YouTube access', async () => {
    const { report, resolver } = await run('plays', 'free')
    expect(report).toEqual({ status: 'skipped', song: SELF_TEST_SONG })
    expect(resolver.resolutions).toEqual([])
  })

  it('stops after a blocked play: no other stream would fare better', async () => {
    const resolver = createFakeResolver('capped')
    const { probe, played } = fakeProbe({
      bad: { ok: false, reason: 'blocked', afterMs: 5, playedMs: 0 },
    })
    const report = await runSongSelfTest({ resolver, probe, context: () => context() })
    expect(report).toMatchObject({ status: 'failed', stage: 'play' })
    expect(played).toHaveLength(1)
    expect(resolver.failures).toEqual([])
  })

  it("skips streams the browser can't decode, and capped ones", async () => {
    const opus: StreamOption = {
      url: 'fake://good-opus',
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      tier: 'high',
      bitrateKbps: 140,
      protocol: 'progressive',
      ipBound: true,
      fullLength: 'unverified',
    }
    const aac: StreamOption = { ...opus, url: 'fake://good-aac', codec: 'aac', container: 'm4a' }
    const capped: StreamOption = { ...opus, url: 'fake://good-capped', fullLength: 'capped' }
    const { probe, played } = fakeProbe()
    probe.canPlay = (option) => option.codec === 'aac'
    const report = await runSongSelfTest({
      resolver: { hasFallback: false, resolve: async () => [capped, opus, aac] },
      probe,
      context: () => context(),
    })
    expect(report.status).toBe('passed')
    expect(played).toEqual(['fake://good-aac'])
  })

  it('fails without trying anything when nothing is decodable', async () => {
    const { probe } = fakeProbe()
    probe.canPlay = () => false
    const report = await runSongSelfTest({
      resolver: createFakeResolver('plays'),
      probe,
      context: () => context(),
    })
    expect(report).toMatchObject({ status: 'failed', stage: 'none', attempts: [] })
  })

  it('is cancelled by its signal, during the resolution or the play', async () => {
    const controller = new AbortController()
    const resolver = createFakeResolver('plays', { latencyMs: 50 })
    const { probe } = fakeProbe()
    const pending = runSongSelfTest({
      resolver,
      probe,
      context: () => ({ ...context(), signal: controller.signal }),
      signal: controller.signal,
    })
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled', song: SELF_TEST_SONG })

    const aborted = fakeProbe({ good: { ok: false, reason: 'aborted', afterMs: 1, playedMs: 0 } })
    expect(
      await runSongSelfTest({
        resolver: createFakeResolver('plays'),
        probe: aborted.probe,
        context: () => context(),
      }),
    ).toEqual({ status: 'cancelled', song: SELF_TEST_SONG })
  })
})

describe('describeStream', () => {
  it("uses the ladder's label and rung when the option has them", () => {
    const option = {
      url: 'x',
      codec: 'aac',
      container: 'mp4',
      media: 'muxed-video',
      tier: 'high',
      bitrateKbps: 128,
      protocol: 'progressive',
      ipBound: true,
      fullLength: 'unverified',
      label: 'AAC from 360p video',
      rung: 'android-muxed',
    } as const
    expect(describeStream(option)).toBe('AAC from 360p video · 128 kbps · ANDROID')
  })

  it('falls back to the codec', () => {
    expect(
      describeStream({
        url: 'x',
        codec: 'opus',
        container: 'webm',
        media: 'audio',
        tier: 'high',
        protocol: 'progressive',
        ipBound: true,
        fullLength: 'verified',
      }),
    ).toBe('Opus')
  })
})
