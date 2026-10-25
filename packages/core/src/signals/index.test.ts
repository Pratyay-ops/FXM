import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from '../index'

describe('the listening signals in the @fxm/core entry point', () => {
  it.each([
    ['signal types', ['LISTENING_SIGNAL_TYPES']],
    ['signal times', ['MAX_SIGNAL_TIME', 'isSignalTime']],
    [
      'affinity',
      [
        'AFFINITY_HALF_LIFE_MS',
        'AFFINITY_KINDS',
        'AFFINITY_MODEL_VERSION',
        'DEFAULT_AFFINITY_WEIGHTS',
      ],
    ],
    ['affinity math', ['decayFactor', 'affinityAt', 'affinityRank', 'mergeAffinity']],
    [
      'contributions',
      [
        'affinityContributions',
        'affinityCredits',
        'reattributeAffinity',
        'isEmptyAffinity',
        'MAX_AFFINITY_IDS',
      ],
    ],
    ['reads', ['affinityScoreAt', 'compareAffinityScores', 'affinityEntryId', 'affinityKey']],
    ['the index', ['AffinityIndex']],
    ['keys', ['artistKey', 'artistAffinityKey', 'tagAffinityKey', 'trackAffinityKey']],
    [
      'plays',
      ['ASSUMED_TRACK_MS', 'COMPLETED_PLAY_SHARE', 'playedShare', 'playContextOf', 'playStreamOf'],
    ],
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
    expectTypeOf<core.Track>().toExtend<core.ListeningSignalTrack>()
  })

  it('lets an in-memory index stand in for any store of the affinity', () => {
    expectTypeOf<ReturnType<core.AffinityIndex['reader']>>().toEqualTypeOf<core.AffinityReader>()
  })
})
