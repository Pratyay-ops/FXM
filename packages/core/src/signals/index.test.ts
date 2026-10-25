import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from '../index'

describe('the listening signals in the @fxm/core entry point', () => {
  it.each([
    ['signal types', ['LISTENING_SIGNAL_TYPES']],
    ['affinity', ['AFFINITY_HALF_LIFE_MS', 'AFFINITY_KINDS', 'DEFAULT_AFFINITY_WEIGHTS']],
    ['affinity math', ['decayFactor', 'affinityAt', 'affinityRank', 'mergeAffinity']],
    ['contributions', ['signalContributions', 'isEmptyAffinity', 'MAX_AFFINITY_IDS']],
    ['the index', ['AffinityIndex']],
    ['keys', ['artistAffinityKey', 'tagAffinityKey']],
    ['plays', ['ASSUMED_TRACK_MS', 'playedShare', 'playContextOf', 'playStreamOf']],
  ])('re-exports the %s', (_part, names) => {
    for (const name of names) expect(core).toHaveProperty(name)
  })

  it('names every signal type once', () => {
    expect(core.LISTENING_SIGNAL_TYPES).toEqual([
      'play',
      'like',
      'unlike',
      'playlist-add',
      'playlist-remove',
    ])
    expectTypeOf<core.ListeningSignal['type']>().toEqualTypeOf<core.ListeningSignalType>()
  })

  it('accepts a whole track wherever a signal needs one', () => {
    expectTypeOf<core.Track>().toExtend<core.SignalTrack>()
  })
})
