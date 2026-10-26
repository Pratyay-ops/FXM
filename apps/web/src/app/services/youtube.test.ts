import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  type ProviderContext,
  type StreamFailureFacts,
  type StreamOption,
  type StreamRecovery,
} from '@fxm/core'
import type { StreamSourceRequest } from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from './device-store'
import type { Loader } from './lazy-provider'
import {
  createYouTubeLoader,
  platformStreamBudget,
  type YouTube,
  type YouTubeModule,
  youtubeStreamSource,
} from './youtube'

const ctx = { mode: 'music', platform: 'web' } as ProviderContext

const candidate: AudioCandidate = {
  source: 'ytm',
  ref: 'zFYEYRcjK2g',
  kind: 'song',
  title: 'Creep',
  artists: ['Radiohead'],
  confidence: 1,
  evidence: [],
}

function option(rung: string): StreamOption & { rung: string; videoId: string } {
  return {
    url: `https://rr1---sn-fxm.googlevideo.com/videoplayback?rung=${rung}`,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'unverified',
    rung,
    videoId: 'zFYEYRcjK2g',
  }
}

/** A loader over a fake ladder that records what it is asked. */
function fakeYouTube() {
  const audio = {
    hasFallback: false,
    resolve: vi.fn(async (..._args: unknown[]) => [option('visionos')]),
    reportPlaybackFailure: vi.fn(),
    checkStatus: vi.fn(async () => 403),
  }
  const module = {
    isYouTubeStreamOption: (value: unknown) =>
      typeof value === 'object' && value !== null && 'rung' in value,
    unavailableStateOf: (error: unknown) =>
      error instanceof Error && error.message === 'kids' ? 'made-for-kids' : undefined,
  }
  const youtube = { audio, module, fallbackRung: 'android-muxed' } as unknown as YouTube
  let current: YouTube | undefined
  const loader: Loader<YouTube> = {
    get current() {
      return current
    },
    load: async () => {
      current = youtube
      return youtube
    },
  }
  return { loader, audio }
}

function request(overrides: Partial<StreamSourceRequest> = {}): StreamSourceRequest {
  return {
    ctx,
    prefs: DEFAULT_QUALITY_PREFS,
    rung: 'top',
    priority: 'current-track',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('platformStreamBudget', () => {
  it('takes no slot: the transport draws one for every InnerTube call', async () => {
    const sink = { reportBotCheck: vi.fn() }

    await expect(platformStreamBudget(() => sink).acquire('current-track')).resolves.toBeUndefined()
    expect(sink.reportBotCheck).not.toHaveBeenCalled()
  })

  it('passes on the bot checks only the ladder tells apart, and leaves 429s to the transport', () => {
    const sink = { reportBotCheck: vi.fn() }
    const budget = platformStreamBudget(() => sink)

    budget.reportBotCheck('login-required')
    budget.reportBotCheck('rate-limited')

    expect(sink.reportBotCheck.mock.calls).toEqual([['login-required']])
  })

  it('drops reports while there is no platform yet', () => {
    expect(() =>
      platformStreamBudget(() => undefined).reportBotCheck('login-required'),
    ).not.toThrow()
  })
})

describe('youtubeStreamSource', () => {
  it('runs the whole ladder for the top rung, at the request priority', async () => {
    const { loader, audio } = fakeYouTube()
    const source = youtubeStreamSource(loader)
    const signal = new AbortController().signal

    await source.resolve(candidate, request({ priority: 'prefetch', signal }))

    expect(audio.resolve).toHaveBeenCalledWith(
      candidate,
      { ...ctx, signal },
      DEFAULT_QUALITY_PREFS,
      { rungs: 'all', priority: 'prefetch' },
    )
  })

  it('asks only the last-resort rung for the fallback', async () => {
    const { loader, audio } = fakeYouTube()

    await youtubeStreamSource(loader).resolve(candidate, request({ rung: 'fallback' }))

    expect(audio.resolve.mock.calls[0]?.[3]).toEqual({
      rungs: 'fallback',
      priority: 'current-track',
    })
  })

  it('says which rung an option came from, once the ladder loaded', async () => {
    const { loader } = fakeYouTube()
    const source = youtubeStreamSource(loader)

    expect(source.rungOf?.(option('visionos'))).toBeUndefined()
    expect(source.hasFallback).toBe(true)
    await loader.load()

    expect(source.rungOf?.(option('visionos'))).toBe('top')
    expect(source.rungOf?.(option('android-muxed'))).toBe('fallback')
    // An option the ladder did not resolve, e.g. an Internet Archive file.
    const { rung: _rung, videoId: _videoId, ...archive } = option('x')
    expect(source.rungOf?.(archive)).toBeUndefined()
    expect(source.hasFallback).toBe(false)
  })

  it('tells the ladder which rung failed, in its words', async () => {
    const { loader, audio } = fakeYouTube()
    const source = youtubeStreamSource(loader)
    await loader.load()
    const stream = option('visionos')
    const report = (reason: StreamRecovery['reason']) =>
      source.reportFailure?.(
        stream,
        {
          facts: {} as StreamFailureFacts,
          recovery: { target: 'fallback', flushAll: false, avoidFormat: false, reason },
        },
        { ctx, signal: new AbortController().signal },
      )

    report('probe-failed')
    report('unsupported')

    expect(audio.reportPlaybackFailure.mock.calls).toEqual([[stream, ctx, 'probe-failed']])
  })

  it('reads labelled states and statuses through the ladder', async () => {
    const { loader, audio } = fakeYouTube()
    const source = youtubeStreamSource(loader)
    await loader.load()
    const signal = new AbortController().signal

    expect(source.stateOf?.(new Error('kids'))).toBe('made-for-kids')
    await expect(source.checkStatus?.(option('visionos'), { ctx, signal })).resolves.toBe(403)
    expect(audio.checkStatus).toHaveBeenCalledWith(option('visionos'), { ...ctx, signal })
  })
})

describe('createYouTubeLoader', () => {
  it('loads the providers and the ladder on one session, once', async () => {
    const importModule = vi.fn(() => import('@fxm/sources/youtube'))
    const onLoad = vi.fn()
    const loader = createYouTubeLoader({
      store: createMemoryStore(),
      budget: platformStreamBudget(() => undefined),
      importModule,
      onLoad,
    })

    expect(importModule).not.toHaveBeenCalled()
    const youtube = await loader.load()
    await loader.load()

    expect(importModule).toHaveBeenCalledOnce()
    expect(youtube.music.session).toBe(youtube.session)
    expect(youtube.video.session).toBe(youtube.session)
    expect(youtube.audio.session).toBe(youtube.session)
    expect(youtube.fallbackRung).toBe('android-muxed')
    expect(onLoad).toHaveBeenCalledWith(youtube)
    expect((youtube.module satisfies YouTubeModule).BUNDLED_STREAM_CONFIG.rungs[0]?.id).toBe(
      'visionos',
    )
  })
})
