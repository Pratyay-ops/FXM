import { type AudioCandidate, isFxmError, type ProviderContext, type StreamOption } from '@fxm/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fromAudioSource,
  getSongResolver,
  type LadderAudioSource,
  SELF_TEST_SONG,
  setSongResolver,
  songCandidate,
  subscribeSongResolver,
  unavailableResolver,
  useSongResolver,
} from './resolver'
import { TIER_CAPABILITIES } from './testing'

const ctx: ProviderContext = {
  fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch,
  platform: 'web',
  capabilities: TIER_CAPABILITIES.full,
  mode: 'music',
}

const option: StreamOption = {
  url: 'https://rr1---sn-fake.googlevideo.com/videoplayback?itag=251',
  codec: 'opus',
  container: 'webm',
  media: 'audio',
  tier: 'high',
  protocol: 'progressive',
  ipBound: true,
  fullLength: 'verified',
}

afterEach(() => {
  setSongResolver(unavailableResolver)
})

describe("the app's resolver", () => {
  it('is unavailable until stage 1.4 is wired in', async () => {
    expect(getSongResolver()).toBe(unavailableResolver)
    expect(unavailableResolver.hasFallback).toBe(false)
    const error = await unavailableResolver.resolve(SELF_TEST_SONG, ctx, { rungs: 'all' }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })

  it('can be replaced', () => {
    const resolver = fromAudioSource({ id: 'ytm', match: vi.fn(), resolve: vi.fn() })
    setSongResolver(resolver)
    expect(getSongResolver()).toBe(resolver)
  })

  it('tells its subscribers when it changes, and only then', () => {
    const heard = vi.fn()
    const stop = subscribeSongResolver(heard)
    const resolver = fromAudioSource({ id: 'ytm', match: vi.fn(), resolve: vi.fn() })
    setSongResolver(resolver)
    setSongResolver(resolver)
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    setSongResolver(unavailableResolver)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('renders a component again when YouTube’s ladder arrives', () => {
    const { result } = renderHook(() => useSongResolver())
    expect(result.current).toBe(unavailableResolver)
    const resolver = fromAudioSource({ id: 'ytm', match: vi.fn(), resolve: vi.fn() })
    act(() => setSongResolver(resolver))
    expect(result.current).toBe(resolver)
  })
})

describe('fromAudioSource', () => {
  it('resolves the song as a ytm candidate, with the rungs, and passes the reports on', async () => {
    const calls: { candidate: AudioCandidate; options: unknown }[] = []
    const audio: LadderAudioSource = {
      id: 'ytm',
      hasFallback: true,
      match: vi.fn(),
      resolve: async (candidate, _ctx, _prefs, options) => {
        calls.push({ candidate, options })
        return [option]
      },
      reportPlaybackSuccess: vi.fn(),
      reportPlaybackFailure: vi.fn(),
    }
    const resolver = fromAudioSource(audio)

    expect(resolver.hasFallback).toBe(true)
    expect(await resolver.resolve(SELF_TEST_SONG, ctx, { rungs: 'fallback' })).toEqual([option])
    expect(calls).toEqual([
      { candidate: songCandidate(SELF_TEST_SONG), options: { rungs: 'fallback' } },
    ])
    expect(calls[0]?.candidate).toMatchObject({ source: 'ytm', ref: 'zFYEYRcjK2g', kind: 'song' })

    resolver.reportPlaybackSuccess?.(option, ctx)
    resolver.reportPlaybackFailure?.(option, ctx, 'probe-failed')
    expect(audio.reportPlaybackSuccess).toHaveBeenCalledWith(option, ctx)
    expect(audio.reportPlaybackFailure).toHaveBeenCalledWith(option, ctx, 'probe-failed')
  })

  it('works with a plain AudioSource, which has no fallback and hears no reports', () => {
    const resolver = fromAudioSource({ id: 'ytm', match: vi.fn(), resolve: vi.fn() })
    expect(resolver.hasFallback).toBe(false)
    expect(() => resolver.reportPlaybackSuccess?.(option, ctx)).not.toThrow()
  })
})
