import { describe, expect, it } from 'vitest'
import * as core from '../index'

describe('the @fxm/core entry point', () => {
  it.each([
    ['queue operations', ['createQueue', 'setQueue', 'playNext', 'addToQueue', 'clearUpcoming']],
    ['queue edits', ['removeFromQueue', 'moveInQueue', 'setCandidate', 'setQueueMode']],
    ['navigation', ['skipToNext', 'skipToPrevious', 'jumpTo', 'PREVIOUS_RESTART_MS']],
    ['shuffle and repeat', ['setShuffle', 'setRepeat', 'REPEAT_MODES', 'isRepeatMode']],
    ['reading', ['currentItem', 'upcomingItems', 'nextItem', 'hasNextItem']],
    ['randomness', ['fisherYatesShuffle', 'createSeededRandom']],
    ['restoring', ['restoreQueue', 'isQueueContext', 'QUEUE_CONTEXT_TYPES']],
  ])('re-exports the %s', (_group, names) => {
    for (const name of names) expect(core).toHaveProperty(name)
  })
})
