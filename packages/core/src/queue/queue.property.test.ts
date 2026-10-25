/**
 * Property-style tests: random sequences of queue operations, driven by seeded random sources
 * so every run is reproducible, with the queue's invariants checked after every step.
 */

import { describe, expect, it } from 'vitest'
import { type CatalogMode, isPlayable, modePolicy } from '../mode'
import type { Track, TrackKind } from '../model'
import {
  addToQueue,
  clearUpcoming,
  createQueue,
  currentItem,
  hasNextItem,
  jumpTo,
  moveInQueue,
  playNext,
  type QueueState,
  REPEAT_MODES,
  removeFromQueue,
  setCandidate,
  setQueue,
  setQueueMode,
  setRepeat,
  setShuffle,
  skipToNext,
  skipToPrevious,
} from './queue'
import { createSeededRandom, type RandomSource } from './random'
import { candidate, track } from './test-tracks'

const RUNS = 250
const STEPS = 40

function randomInt(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

function pick<T>(random: RandomSource, values: readonly T[]): T {
  return values[randomInt(random, 0, values.length - 1)] as T
}

/** Mostly songs, with some music videos, videos and episodes. */
function kindFor(n: number): TrackKind {
  if (n % 7 === 3) return 'music-video'
  if (n % 7 === 5) return 'video'
  if (n % 11 === 7) return 'episode'
  return 'song'
}

function randomTracks(random: RandomSource, max: number): Track[] {
  return Array.from({ length: randomInt(random, 0, max) }, () => {
    const n = randomInt(random, 0, 40)
    return track(`t${n}`, kindFor(n))
  })
}

const uidsOf = (state: QueueState) => state.items.map((item) => item.uid)

/** Whether the current item is one a mode switch hid, which leaves once playback moves on. */
function isHiddenCurrent(state: QueueState): boolean {
  const current = currentItem(state)
  return current !== undefined && modePolicy(current.track, state.mode) === 'hidden'
}
const byNumber = (a: number, b: number) => a - b

/**
 * Every documented invariant that `state` breaks, as messages. `hiddenCurrentOk` allows the
 * current item to be hidden, which only a mode switch may cause.
 */
function violations(state: QueueState, hiddenCurrentOk: boolean): string[] {
  const problems: string[] = []
  const uids = uidsOf(state)
  const current = currentItem(state)
  if (state.items.length === 0 ? state.index !== -1 : current === undefined) {
    problems.push(`index ${state.index} with ${state.items.length} items`)
  }
  if (new Set(uids).size !== uids.length) problems.push('duplicate uids')
  if (uids.some((uid) => uid >= state.nextUid)) problems.push('uid not below nextUid')
  if (new Set(state.history).size !== state.history.length) problems.push('duplicate history')
  if (state.history.some((uid) => !uids.includes(uid))) problems.push('history uid not queued')
  if (current !== undefined && state.history.includes(current.uid)) {
    problems.push('current item in history')
  }
  if (state.shuffle) {
    const original = [...(state.unshuffled ?? [])].sort(byNumber)
    if (original.join() !== [...uids].sort(byNumber).join()) problems.push('unshuffled mismatch')
  } else if (state.unshuffled !== undefined) {
    problems.push('unshuffled without shuffle')
  }
  for (const item of state.items) {
    const hiddenOk = hiddenCurrentOk && item === current
    if (!hiddenOk && modePolicy(item.track, state.mode) === 'hidden') problems.push('hidden item')
    if (item.candidate !== undefined && !isPlayable(item.candidate, state.mode)) {
      problems.push('unplayable candidate')
    }
  }
  if (JSON.stringify(JSON.parse(JSON.stringify(state))) !== JSON.stringify(state)) {
    problems.push('not plain JSON')
  }
  return problems
}

/** The queue plus what the original order should be while shuffle is on. */
interface Model {
  state: QueueState
  /** The expected `unshuffled` order: what turning shuffle off must restore. */
  original: number[] | undefined
  /** Whether a mode switch may have left a hidden item current. */
  hiddenCurrentOk: boolean
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i)
}

/** Applies one random operation and updates the expected original order alongside. */
function step(model: Model, random: RandomSource): Model {
  const before = model.state
  const keepOriginal = (state: QueueState): Model => {
    const kept = new Set(uidsOf(state))
    const original = model.original?.filter((uid) => kept.has(uid))
    return { ...model, state, original }
  }
  switch (randomInt(random, 0, 12)) {
    case 0: {
      const tracks = randomTracks(random, 8)
      const state = setQueue(
        before,
        tracks,
        randomInt(random, -1, tracks.length),
        undefined,
        random,
      )
      return {
        state,
        original: state.shuffle ? range(before.nextUid, state.nextUid) : undefined,
        hiddenCurrentOk: false,
      }
    }
    case 1: {
      const state = playNext(before, randomTracks(random, 3))
      const added = range(before.nextUid, state.nextUid)
      let original = model.original
      const current = currentItem(before)
      if (original !== undefined && current !== undefined) {
        const at = original.indexOf(current.uid) + 1
        original = [...original.slice(0, at), ...added, ...original.slice(at)]
      } else if (original !== undefined) {
        original = added
      }
      return { ...model, state, original }
    }
    case 2: {
      const state = addToQueue(before, randomTracks(random, 3))
      const added = range(before.nextUid, state.nextUid)
      return { ...model, state, original: model.original && [...model.original, ...added] }
    }
    case 3:
      return keepOriginal(removeFromQueue(before, randomInt(random, -1, before.items.length)))
    case 4: {
      const last = before.items.length
      return keepOriginal(
        moveInQueue(before, randomInt(random, -1, last), randomInt(random, 0, last)),
      )
    }
    case 5:
      return keepOriginal(clearUpcoming(before))
    case 6:
      return keepOriginal(skipToNext(before))
    case 7:
      return keepOriginal(skipToPrevious(before, randomInt(random, 0, 6000)))
    case 8:
      return keepOriginal(jumpTo(before, randomInt(random, -1, before.items.length)))
    case 9: {
      const on = random() < 0.5
      const state = setShuffle(before, on, random)
      if (on && !before.shuffle) return { ...model, state, original: uidsOf(before) }
      if (!on && before.shuffle) {
        expect(uidsOf(state)).toEqual(model.original)
        expect(currentItem(state)?.uid).toBe(currentItem(before)?.uid)
        return { ...model, state, original: undefined }
      }
      return { ...model, state }
    }
    case 10:
      return keepOriginal(setRepeat(before, pick(random, REPEAT_MODES)))
    case 11: {
      const mode = pick(random, ['music', 'all'] as const satisfies readonly CatalogMode[])
      const state = setQueueMode(before, mode)
      return { ...keepOriginal(state), hiddenCurrentOk: model.hiddenCurrentOk || state !== before }
    }
    default: {
      const target = pick(random, [...before.items, undefined])
      const kind = pick(random, ['song', 'music-video', 'video'] as const)
      return keepOriginal(
        setCandidate(before, target?.uid ?? 99, random() < 0.2 ? undefined : candidate('c', kind)),
      )
    }
  }
}

/** Runs `check` on the state after every step of `RUNS` random operation sequences. */
function forEachRandomState(check: (state: QueueState, random: RandomSource) => void): void {
  for (let run = 0; run < RUNS; run += 1) {
    const random = createSeededRandom(run)
    let model: Model = {
      state: createQueue({ mode: pick(random, ['music', 'all'] as const) }),
      original: undefined,
      hiddenCurrentOk: false,
    }
    for (let i = 0; i < STEPS; i += 1) {
      model = step(model, random)
      check(model.state, random)
      const problems = violations(model.state, model.hiddenCurrentOk)
      if (problems.length > 0) {
        throw new Error(`run ${run}, step ${i}: ${problems.join('; ')}`)
      }
    }
  }
}

describe('queue invariants under random operations', () => {
  it('hold after every operation, and unshuffling restores the expected order', () => {
    let steps = 0
    forEachRandomState(() => {
      steps += 1
    })
    expect(steps).toBe(RUNS * STEPS)
  })

  it('shuffle on then off restores the order and keeps the current item', () => {
    forEachRandomState((state, random) => {
      if (state.shuffle) return
      const restored = setShuffle(setShuffle(state, true, random), false)
      expect(uidsOf(restored)).toEqual(uidsOf(state))
      expect(restored.index).toBe(state.index)
    })
  })

  it('shuffle keeps every item and the current one, with the history first', () => {
    forEachRandomState((state, random) => {
      if (state.shuffle) return
      const shuffled = setShuffle(state, true, random)
      expect([...uidsOf(shuffled)].sort(byNumber)).toEqual([...uidsOf(state)].sort(byNumber))
      expect(currentItem(shuffled)?.uid).toBe(currentItem(state)?.uid)
      expect(uidsOf(shuffled).slice(0, shuffled.index)).toEqual(state.history)
      expect(shuffled.unshuffled).toEqual(uidsOf(state))
    })
  })

  it('previous right after next comes back to the same item', () => {
    forEachRandomState((state) => {
      if (!hasNextItem(state) || isHiddenCurrent(state)) return
      const back = skipToPrevious(skipToNext(state), 0)
      expect(currentItem(back)?.uid).toBe(currentItem(state)?.uid)
    })
  })

  it('next right after previous comes back to the same item', () => {
    forEachRandomState((state) => {
      const back = skipToPrevious(state, 0)
      if (back === state || isHiddenCurrent(state)) return
      expect(currentItem(skipToNext(back))?.uid).toBe(currentItem(state)?.uid)
    })
  })

  it('never lets a hidden track join the queue', () => {
    forEachRandomState((state, random) => {
      const tracks = randomTracks(random, 5)
      for (const next of [playNext(state, tracks), addToQueue(state, tracks)]) {
        const added = next.items.filter((item) => item.uid >= state.nextUid)
        for (const item of added) expect(modePolicy(item.track, state.mode)).not.toBe('hidden')
      }
    })
  })
})
