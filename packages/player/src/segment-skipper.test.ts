import { type AudioCandidate, currentQueueItem, type QueueItem, type Track } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Player, type PlayerOptions } from './player'
import type { ResolvedStream } from './resolver'
import {
  activeSkipSegments,
  connectSegmentSkipper,
  type SegmentSkip,
  type SegmentSkipperOptions,
  type SkipSegment,
} from './segment-skipper'
import { FakeEngine, FakeResolver, testStream, testTrack } from './testing'

/** Lets pending promise chains and due timers run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Segments from `startS` to `endS`, in seconds, for brevity. */
const seg = (startS: number, endS: number, extra: Partial<SkipSegment> = {}): SkipSegment => ({
  startMs: startS * 1000,
  endMs: endS * 1000,
  ...extra,
})

/** Three-minute tracks, as `testTrack` makes them. */
const a = testTrack('a')
const b = testTrack('b')

interface SetupOptions {
  /** Segments by track title. */
  segments?: Record<string, readonly SkipSegment[]>
  player?: Partial<PlayerOptions>
  skipper?: Partial<SegmentSkipperOptions>
}

function setup(options: SetupOptions = {}) {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver, stallTimeoutMs: 0, ...options.player })
  const segments: Record<string, readonly SkipSegment[]> = { ...options.segments }
  const asked: string[] = []
  const signals: AbortSignal[] = []
  const skipper = connectSegmentSkipper(player, {
    segmentsFor: async (item, signal) => {
      asked.push(item.track.title)
      signals.push(signal)
      return segments[item.track.title] ?? []
    },
    ...options.skipper,
  })
  const skips: SegmentSkip[] = []
  skipper.on('skip', (skip) => skips.push(skip))
  /** Where the player asked the engine to seek, in order. */
  const engineSeeks = () =>
    engine.calls.flatMap((call) => (call.method === 'seek' ? [call.args[0] as number] : []))
  /** Each skip as `from -> to`. */
  const skipLog = () => skips.map(({ fromMs, toMs }) => `${fromMs} -> ${toMs}`)
  return {
    engine,
    resolver,
    player,
    skipper,
    segments,
    asked,
    signals,
    skips,
    engineSeeks,
    skipLog,
  }
}

/** Plays `tracks` and lets everything settle: the first track is playing at 0. */
async function playing(
  context: ReturnType<typeof setup>,
  tracks: readonly Track[] = [a],
): Promise<void> {
  await context.player.setQueue(tracks)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connectSegmentSkipper', () => {
  it('skips an intro before the track starts, when its segments come first', async () => {
    const context = setup({ segments: { a: [seg(0, 12)] } })
    const resolution = deferred<ResolvedStream>()
    context.resolver.handler = () => resolution.promise

    void context.player.setQueue([a])
    await settle()
    resolution.resolve({ stream: testStream('a') })
    await settle()

    expect(context.engine.loadStarts).toEqual([12_000])
    expect(context.engineSeeks()).toEqual([])
    expect(context.player.getState()).toMatchObject({ status: 'playing', positionMs: 12_000 })
    expect(context.skipLog()).toEqual(['0 -> 12000'])
    expect(context.skips[0]?.item.track.title).toBe('a')
  })

  it('skips an intro that becomes known once the track plays', async () => {
    const context = setup()
    const answer = deferred<readonly SkipSegment[]>()
    const skipper = connectSegmentSkipper(context.player, { segmentsFor: () => answer.promise })
    const skips: string[] = []
    skipper.on('skip', ({ fromMs, toMs }) => skips.push(`${fromMs} -> ${toMs}`))
    await playing(context)
    context.engine.progress(1200)

    answer.resolve([seg(0, 12)])
    await settle()

    expect(skips).toEqual(['1200 -> 12000'])
    expect(context.engine.positionMs).toBe(12_000)
  })

  it('skips a segment in the middle when playback reaches it', async () => {
    const context = setup({ segments: { a: [seg(60, 70)] } })
    await playing(context)

    context.engine.progress(30_000)
    await settle()
    expect(context.engineSeeks()).toEqual([])

    context.engine.progress(61_300)
    await settle()
    expect(context.engineSeeks()).toEqual([70_000])
    expect(context.skipLog()).toEqual(['61300 -> 70000'])
  })

  it('skips right at the start of a segment that is about to begin', async () => {
    const context = setup({ segments: { a: [seg(60, 70)] } })
    await playing(context)

    context.engine.progress(59_400)
    await settle(599)
    expect(context.engineSeeks()).toEqual([])
    await settle(1)

    expect(context.engineSeeks()).toEqual([70_000])
    expect(context.skipLog()).toEqual(['60000 -> 70000'])
  })

  it('counts the time since the last position report when it sets the timer', async () => {
    const context = setup({ segments: { a: [seg(60, 70)] } })
    await playing(context)
    context.engine.progress(58_800)
    await settle(300)
    // Something else changes, without a new position: the timer keeps its deadline.
    context.player.setVolume(0.5)
    await settle(599)
    expect(context.engineSeeks()).toEqual([])
    await settle(301)
    expect(context.engineSeeks()).toEqual([70_000])
  })

  it('sets no timer while waiting for data, and none far ahead', async () => {
    const context = setup({ segments: { a: [seg(60, 70)] } })
    await playing(context)
    context.engine.progress(50_000)
    await settle(2000)
    expect(context.engineSeeks()).toEqual([])

    context.engine.progress(59_500)
    context.engine.emit('waiting', undefined)
    await settle(2000)
    expect(context.engineSeeks()).toEqual([])
  })

  it("doesn't take its own seeks for the user's", async () => {
    const context = setup({ segments: { a: [seg(10, 20), seg(30, 40)] } })
    await playing(context)
    context.engine.progress(10_100)
    await settle()
    context.engine.progress(30_100)
    await settle()
    expect(context.skipLog()).toEqual(['10100 -> 20000', '30100 -> 40000'])
  })

  describe('what the user chose', () => {
    it('leaves a segment the user moved playback into', async () => {
      const context = setup({ segments: { a: [seg(60, 90)] } })
      await playing(context)

      context.player.seek(75_000)
      await settle()
      context.engine.progress(76_000)
      await settle()
      expect(context.skips).toEqual([])

      // Back before it: it is skipped again when playback gets there.
      context.player.seek(50_000)
      context.engine.progress(60_200)
      await settle()
      expect(context.skipLog()).toEqual(['60200 -> 90000'])
    })

    it('still skips a segment the user moved to the very start of', async () => {
      const context = setup({ segments: { a: [seg(0, 12)] } })
      await playing(context)
      expect(context.skipLog()).toEqual(['0 -> 12000'])

      context.player.seek(0)
      await settle()
      expect(context.skipLog()).toEqual(['0 -> 12000', '0 -> 12000'])
    })

    it('goes back on undo and leaves that segment until the track starts over', async () => {
      const context = setup({ segments: { a: [seg(60, 70)] } })
      await playing(context)
      context.engine.progress(60_100)
      await settle()

      expect(context.skipper.undo()).toBe(true)
      expect(context.engineSeeks()).toEqual([70_000, 60_100])
      context.engine.progress(61_000)
      await settle(2000)
      expect(context.skips).toHaveLength(1)
      expect(context.skipper.undo()).toBe(false)

      // "Previous" more than 3 s in restarts the track: the segment is skipped again.
      await context.player.previous()
      context.engine.progress(60_050)
      await settle()
      expect(context.skips).toHaveLength(2)
    })

    it('has nothing to undo once the user moved playback, or the track changed', async () => {
      const context = setup({ segments: { a: [seg(60, 70)], b: [seg(60, 70)] } })
      await playing(context, [a, b])
      context.engine.progress(60_100)
      await settle()
      context.player.seek(100_000)
      expect(context.skipper.undo()).toBe(false)

      await context.player.next()
      await settle()
      context.engine.progress(60_100)
      await settle()
      expect(context.skips.map(({ item }) => item.track.title)).toEqual(['a', 'b'])
      await context.player.previous() // more than 3 s in: starts b over
      await settle()
      expect(context.skipper.undo()).toBe(false)
    })

    it('has nothing to undo after the track changed', async () => {
      const context = setup({ segments: { a: [seg(60, 70)] } })
      await playing(context, [a, b])
      context.engine.progress(60_100)
      await settle()
      await context.player.next()
      await settle()
      expect(context.skipper.undo()).toBe(false)
      expect(context.engineSeeks()).toEqual([70_000])
    })

    it('skips every segment again when the track repeats', async () => {
      const context = setup({ segments: { a: [seg(0, 12)] } })
      context.player.setRepeat('one')
      await playing(context)
      expect(context.skipper.undo()).toBe(true)
      context.engine.progress(5000)

      context.engine.end()
      await settle()

      expect(context.skipLog()).toEqual(['0 -> 12000', '0 -> 12000'])
    })

    it('waits while paused, and leaves the segment a restored queue stopped in', async () => {
      const source = setup()
      await source.player.setQueue([a], { autoplay: false })
      const context = setup({ segments: { a: [seg(60, 90)] } })

      context.player.restore(source.player.getState().queue, 75_000)
      await settle()
      expect(context.player.getState()).toMatchObject({ status: 'paused', positionMs: 75_000 })

      await context.player.play()
      await settle()
      context.engine.progress(76_000)
      await settle()
      expect(context.skips).toEqual([])
    })

    it('skips the intro of a restored queue at its start', async () => {
      const source = setup()
      await source.player.setQueue([a], { autoplay: false })
      const context = setup({ segments: { a: [seg(0, 12)] } })
      context.player.restore(source.player.getState().queue, 0)
      await settle()
      expect(context.skips).toEqual([])

      await context.player.play()
      await settle()
      expect(context.skipLog()).toEqual(['0 -> 12000'])
    })

    it('takes the position of a player it joins late as the one the user chose', async () => {
      const source = setup()
      await source.player.setQueue([a], { autoplay: false })
      const engine = new FakeEngine()
      const player = new Player({ engine, resolver: new FakeResolver(), stallTimeoutMs: 0 })
      player.restore(source.player.getState().queue, 65_000)
      const skips: SegmentSkip[] = []
      connectSegmentSkipper(player, { segmentsFor: () => [seg(60, 90)] }).on('skip', (skip) =>
        skips.push(skip),
      )

      await player.play()
      await settle()
      engine.progress(66_000)
      await settle()
      expect(skips).toEqual([])
    })
  })

  describe('the end of the track', () => {
    it('ends the track at a segment that runs to the end, so the next one plays', async () => {
      const context = setup({ segments: { a: [seg(170, 180)] } })
      await playing(context, [a, b])

      context.engine.progress(170_200)
      await settle()
      expect(context.skipLog()).toEqual(['170200 -> 179900'])
      expect(context.skips[0]?.segment).toEqual(seg(170, 180))

      context.engine.end()
      await settle()
      expect(currentQueueItem(context.player.getState().queue)?.track.title).toBe('b')
    })

    it('runs a segment that ends just before the end on to the end', async () => {
      const context = setup({ segments: { a: [seg(170, 179.4)] } })
      await playing(context)
      context.engine.progress(170_200)
      await settle()
      expect(context.skipLog()).toEqual(['170200 -> 179900'])
    })

    it('waits for the track to play before it skips to its end', async () => {
      const context = setup({ segments: { a: [seg(170, 180)] } })
      await context.player.setQueue([a], { startAtMs: 175_000, autoplay: false })
      context.engine.startOnPlay = false
      void context.player.play()
      await settle()
      expect(context.player.getState().status).toBe('loading')
      expect(context.skips).toEqual([])

      context.engine.emit('play', undefined)
      await settle()
      expect(context.skipLog()).toEqual(['175000 -> 179900'])
    })
  })

  describe('where segments come from', () => {
    it('asks for each track as it becomes current, and cancels what is no longer needed', async () => {
      const context = setup()
      await playing(context, [a, b])
      expect(context.asked).toEqual(['a'])
      await context.player.next()
      await settle()
      expect(context.asked).toEqual(['a', 'b'])
      expect(context.signals.map((signal) => signal.aborted)).toEqual([true, false])
    })

    it('asks for the next track when the player prepares it, and uses the answer', async () => {
      const context = setup({ segments: { b: [seg(0, 12)] } })
      await playing(context, [a, b])
      context.engine.progress(151_000)
      await settle()
      expect(context.asked).toEqual(['a', 'b'])

      context.engine.end()
      await settle()

      expect(context.asked).toEqual(['a', 'b'])
      expect(context.skipLog()).toEqual(['0 -> 12000'])
      expect(context.skips[0]?.item.track.title).toBe('b')
    })

    it('asks again when the audio of the current item changes', async () => {
      const context = setup()
      const song: AudioCandidate = {
        source: 'ytm',
        ref: 'other',
        kind: 'song',
        title: 'a',
        artists: ['a artist'],
        confidence: 0.95,
        evidence: ['isrc'],
      }
      await playing(context)
      const item = currentQueueItem(context.player.getState().queue) as QueueItem
      context.player.setCandidate(item.uid, song)
      await settle()
      expect(context.asked).toEqual(['a', 'a'])
    })

    it('keeps the answer when an item resolves to its own audio', async () => {
      const context = setup({ segments: { a: [seg(60, 70)] } })
      context.resolver.handler = (item) => ({
        stream: testStream(item.track.title),
        candidate: {
          source: 'ytm',
          ref: 'a',
          kind: 'song',
          title: 'a',
          artists: ['a artist'],
          confidence: 1,
          evidence: ['own audio'],
        },
      })
      await playing(context)
      expect(currentQueueItem(context.player.getState().queue)?.candidate?.ref).toBe('a')
      expect(context.asked).toEqual(['a'])
    })

    it('asks again on refresh, for the next track too', async () => {
      const context = setup()
      await playing(context, [a, b])
      context.engine.progress(151_000)
      await settle()
      context.segments.a = [seg(160, 170)]
      context.segments.b = [seg(0, 12)]

      context.skipper.refresh()
      await settle()
      context.engine.progress(160_500)
      await settle()
      expect(context.skipLog()).toEqual(['160500 -> 170000'])

      context.engine.end()
      await settle()
      expect(context.asked).toEqual(['a', 'b', 'a', 'b'])
      expect(context.skipLog()).toEqual(['160500 -> 170000', '0 -> 12000'])
    })

    it('skips nothing when segmentsFor fails or throws, and reports it', async () => {
      const failure = new Error('offline')
      const errors: unknown[] = []
      for (const segmentsFor of [
        () => Promise.reject(failure),
        () => {
          throw failure
        },
      ]) {
        const context = setup()
        const skipper = connectSegmentSkipper(context.player, {
          segmentsFor,
          onError: (error, item) => errors.push([error, item.track.title]),
        })
        const skips: SegmentSkip[] = []
        skipper.on('skip', (skip) => skips.push(skip))
        await playing(context)
        context.engine.progress(60_000)
        await settle(2000)
        expect(skips).toEqual([])
      }
      expect(errors).toEqual([
        [failure, 'a'],
        [failure, 'a'],
      ])
    })

    it('stops on disconnect, and ignores answers that arrive after it', async () => {
      const context = setup()
      const answer = deferred<readonly SkipSegment[]>()
      const skipper = connectSegmentSkipper(context.player, { segmentsFor: () => answer.promise })
      const skips: SegmentSkip[] = []
      skipper.on('skip', (skip) => skips.push(skip))
      await playing(context)

      skipper.disconnect()
      answer.resolve([seg(0, 12)])
      context.engine.progress(1000)
      await settle(2000)

      expect(skips).toEqual([])
      expect(skipper.segments()).toEqual([])
      expect(skipper.undo()).toBe(false)
    })
  })

  it('lists the segments it applies to the current track', async () => {
    const context = setup({ segments: { a: [seg(60, 70), seg(70.5, 80), seg(-5, 0.4)] } })
    expect(context.skipper.segments()).toEqual([])
    await playing(context)
    expect(context.skipper.segments()).toEqual([seg(60, 80)])
  })
})

describe('activeSkipSegments', () => {
  it('sorts, clamps and merges segments', () => {
    expect(
      activeSkipSegments([seg(100, 110), seg(-3, 10), seg(10.5, 20), seg(105, 115)], 180_000),
    ).toEqual([seg(0, 20), seg(100, 115)])
  })

  it('drops invalid and too short segments', () => {
    expect(
      activeSkipSegments(
        [
          seg(10, 10.5),
          { startMs: Number.NaN, endMs: 5000 },
          { startMs: 1000, endMs: Number.POSITIVE_INFINITY },
          seg(30, 20),
          seg(185, 190),
          seg(40, 50),
        ],
        180_000,
      ),
    ).toEqual([seg(40, 50)])
  })

  it('runs a segment ending near the end of the track to the end', () => {
    expect(activeSkipSegments([seg(170, 179.2)], 180_000)).toEqual([seg(170, 180)])
    expect(activeSkipSegments([seg(170, 178.9)], 180_000)).toEqual([seg(170, 178.9)])
  })

  it('ignores segments marked on media of another duration', () => {
    const marked = (s: number) => seg(0, 12, { mediaDurationMs: s * 1000 })
    expect(activeSkipSegments([marked(182)], 180_000)).toEqual([seg(0, 12)])
    expect(activeSkipSegments([marked(177.9)], 180_000)).toEqual([])
    expect(activeSkipSegments([marked(240)], undefined)).toEqual([seg(0, 12)])
  })

  it('skips nothing when too little of the track would be left', () => {
    // 7 s of 180 would be left.
    expect(activeSkipSegments([seg(0, 100), seg(102, 175)], 180_000)).toEqual([])
    expect(activeSkipSegments([seg(0, 100), seg(110, 170)], 180_000)).toEqual([
      seg(0, 100),
      seg(110, 170),
    ])
  })

  it('keeps segments as they are while the duration is unknown', () => {
    expect(activeSkipSegments([seg(0, 500)], undefined)).toEqual([seg(0, 500)])
  })

  it('takes other tuning', () => {
    expect(activeSkipSegments([seg(10, 10.5)], 180_000, { minSegmentMs: 200 })).toEqual([
      seg(10, 10.5),
    ])
    expect(activeSkipSegments([seg(10, 20), seg(23, 30)], 180_000, { mergeGapMs: 5000 })).toEqual([
      seg(10, 30),
    ])
  })
})

describe('the @fxm/player entry point', () => {
  it('exports the segment skipper', async () => {
    const entry = await import('./index')
    expect(entry.connectSegmentSkipper).toBe(connectSegmentSkipper)
    expect(entry.activeSkipSegments).toBe(activeSkipSegments)
    expect(entry.SEGMENT_SKIPPER_DEFAULTS).toMatchObject({ minPlayedMs: 10_000 })
  })
})
