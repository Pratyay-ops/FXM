import {
  type AudioCandidate,
  type CatalogMode,
  formatId,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import {
  createMemoryMatchStore,
  type ReviewItem,
  type StreamResolver,
  type TrackMatcher,
} from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import { type AppPlaybackPolicyOptions, createAppPlaybackPolicy } from './policy'

function track(id: string): Track {
  return {
    id: formatId('spotify', 'track', id),
    source: 'spotify',
    title: `Track ${id}`,
    artists: [{ name: 'Artist' }],
    artwork: [],
    kind: 'song',
  }
}

function guess(ref: string, kind: AudioCandidate['kind'] = 'song'): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind,
    title: 'Track',
    artists: ['Artist'],
    confidence: 0.7,
    evidence: [],
  }
}

/** A lifecycle stand-in whose review list the test changes. */
function fakeLifecycle(initial: readonly ReviewItem[] = []) {
  let listener: ((items: readonly ReviewItem[]) => void) | undefined
  let items = initial
  return {
    lifecycle: {
      on: vi.fn((_type: 'reviewchange', next: (items: readonly ReviewItem[]) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      }),
      reviews: () => items,
      pinMatch: vi.fn(async () => {}),
    } as unknown as AppPlaybackPolicyOptions['lifecycle'],
    emit(next: readonly ReviewItem[]) {
      items = next
      listener?.(next)
    },
    get listening() {
      return listener !== undefined
    },
  }
}

const resolver: StreamResolver = { resolve: vi.fn() }

function policyWith(
  overrides: Partial<AppPlaybackPolicyOptions> & { mode?: () => CatalogMode } = {},
) {
  const lifecycle = fakeLifecycle()
  const matcher: TrackMatcher = {
    match: vi.fn(async () => ({
      band: 'suggest' as const,
      best: guess('best'),
      alternatives: [guess('other'), guess('video', 'music-video'), guess('best')],
    })),
  }
  const options: AppPlaybackPolicyOptions = {
    lifecycle: lifecycle.lifecycle,
    resolver,
    matcher,
    matches: createMemoryMatchStore(),
    mode: () => 'music',
    context: async (signal) => ({ signal }) as unknown as ProviderContext,
    setPlayBestGuesses: vi.fn(),
    ...overrides,
  }
  return { policy: createAppPlaybackPolicy(options), options, lifecycle, matcher }
}

describe('createAppPlaybackPolicy', () => {
  it('hands the player the resolver it was given', () => {
    expect(policyWith().policy.resolver).toBe(resolver)
  })

  it('reports each track that needs review once per guess, the ones known already too', () => {
    const lifecycle = fakeLifecycle([{ track: track('a'), guess: guess('a1'), alternatives: [] }])
    const { policy } = policyWith({ lifecycle: lifecycle.lifecycle })
    const reports: string[] = []

    const stop = policy.onNeedsReview((reviewed, best) =>
      reports.push(`${reviewed.id} ${best.ref}`),
    )
    lifecycle.emit([
      { track: track('a'), guess: guess('a1'), alternatives: [] },
      { track: track('b'), guess: guess('b1'), alternatives: [] },
    ])
    lifecycle.emit([
      { track: track('a'), guess: guess('a2'), alternatives: [] },
      { track: track('b'), guess: guess('b1'), alternatives: [] },
    ])
    stop()

    expect(reports).toEqual(['spotify:track:a a1', 'spotify:track:b b1', 'spotify:track:a a2'])
    expect(lifecycle.listening).toBe(false)
  })

  it("offers the match cache's candidates as the other versions", async () => {
    const { policy, options, matcher } = policyWith()
    await options.matches.put(
      { sourceTrackId: track('a').id, mode: 'music', target: 'song' },
      {
        band: 'suggest',
        candidate: guess('stored'),
        alternatives: [guess('second')],
        evidence: [],
        userPinned: false,
        decidedAt: 0,
      },
    )

    const alternatives = await policy.alternatives(track('a'), new AbortController().signal)

    expect(alternatives.map((alternative) => alternative.ref)).toEqual(['stored', 'second'])
    expect(matcher.match).not.toHaveBeenCalled()
  })

  it('asks the matching engine when the cache has none, keeping what the mode plays', async () => {
    const { policy, matcher } = policyWith()
    const signal = new AbortController().signal

    const alternatives = await policy.alternatives(track('a'), signal)

    // The video can't play in Music mode, and "best" is listed once.
    expect(alternatives.map((alternative) => alternative.ref)).toEqual(['best', 'other'])
    expect(matcher.match).toHaveBeenCalledWith(track('a'), {
      target: 'song',
      ctx: { signal },
      exclude: [],
      priority: 'current-track',
      signal,
    })
  })

  it('rejects with the reason when the caller cancels', async () => {
    const { policy } = policyWith()
    const controller = new AbortController()
    controller.abort(new DOMException('Closed', 'AbortError'))

    await expect(policy.alternatives(track('a'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('pins through the lifecycle, and passes "Play best guesses" on', () => {
    const { policy, lifecycle, options } = policyWith()

    policy.pin(track('a'), guess('picked'))
    policy.setPlayBestGuesses(true)

    expect(lifecycle.lifecycle.pinMatch).toHaveBeenCalledWith(track('a'), guess('picked'))
    expect(options.setPlayBestGuesses).toHaveBeenCalledWith(true)
  })
})
