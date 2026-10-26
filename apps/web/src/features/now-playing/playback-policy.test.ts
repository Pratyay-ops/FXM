import { type AudioCandidate, FxmError, type QueueItem, type Track } from '@fxm/core'
import type { ResolveRequest } from '@fxm/player'
import { testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { connectAppPolicy, createAppPolicy, createPendingPolicy } from './playback-policy'
import { FakePolicy, spotifyTrack, testCandidate } from './testing'

// The app's policy is one for the whole module: each test disconnects what it connected.
const disconnects: (() => void)[] = []

afterEach(() => {
  for (const disconnect of disconnects.splice(0)) disconnect()
})

function connect(policy = new FakePolicy()): FakePolicy {
  disconnects.push(connectAppPolicy(policy))
  return policy
}

const item = (track: Track = testTrack('a')): QueueItem => ({ uid: 0, track })

function request(signal = new AbortController().signal): ResolveRequest {
  return { reason: 'play', attempt: 0, signal, canPlay: () => 'probably' }
}

describe('the app’s policy', () => {
  it('resolves through the policy connected to it', async () => {
    const policy = connect()

    const resolved = await createAppPolicy().resolver.resolve(item(), request())

    expect(resolved.stream.url).toBe('https://media.test/a')
    expect(policy.resolver.log).toEqual(['a:play#0'])
  })

  it('makes what the player asks before a policy is connected wait for one', async () => {
    const app = createAppPolicy()
    const resolving = app.resolver.resolve(item(), request())
    const alternatives = app.alternatives(spotifyTrack('A'), new AbortController().signal)
    app.pin(spotifyTrack('A'), testCandidate('a'))

    const policy = new FakePolicy()
    policy.alternativesOf.set(spotifyTrack('A').id, [testCandidate('b')])
    connect(policy)

    await expect(resolving).resolves.toMatchObject({ stream: { url: 'https://media.test/a' } })
    await expect(alternatives).resolves.toEqual([testCandidate('b')])
    await expect
      .poll(() => policy.pins)
      .toEqual([{ track: spotifyTrack('A'), candidate: testCandidate('a') }])
  })

  it('stops waiting when the request is cancelled', async () => {
    const controller = new AbortController()
    const resolving = createAppPolicy().resolver.resolve(item(), request(controller.signal))

    controller.abort(new DOMException('Stopped', 'AbortError'))

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' })
    const aborted = AbortSignal.abort(new DOMException('Gone', 'AbortError'))
    await expect(createAppPolicy().alternatives(testTrack('a'), aborted)).rejects.toMatchObject({
      message: 'Gone',
    })
  })

  it('passes "Play best guesses" and the review listeners on to each policy connected', () => {
    const app = createAppPolicy()
    const reports: string[] = []
    const stop = app.onNeedsReview((track, guess: AudioCandidate) =>
      reports.push(`${track.title}:${guess.ref}`),
    )
    app.setPlayBestGuesses(true)

    const first = connect()
    expect(first.playBestGuesses).toBe(true)
    first.reportNeedsReview(spotifyTrack('A'), testCandidate('a'))

    // A later policy takes over: the first one's reports no longer reach the app.
    const second = connect()
    first.reportNeedsReview(spotifyTrack('B'), testCandidate('b'))
    second.reportNeedsReview(spotifyTrack('C'), testCandidate('c'))
    app.setPlayBestGuesses(false)
    stop()
    second.reportNeedsReview(spotifyTrack('D'), testCandidate('d'))

    expect(reports).toEqual(['A:a', 'C:c'])
    expect(second.playBestGuesses).toBe(false)
  })

  it('leaves a policy connected later alone when an earlier one disconnects', async () => {
    const earlier = connectAppPolicy(new FakePolicy())
    disconnects.push(connectAppPolicy(createPendingPolicy()))

    earlier()

    await expect(createAppPolicy().resolver.resolve(item(), request())).rejects.toEqual(
      expect.any(FxmError),
    )
  })
})
