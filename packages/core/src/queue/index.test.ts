import { describe, expect, it } from 'vitest'
import * as core from '../index'

describe('the @fxm/core entry point', () => {
  it.each([
    ['queue operations', ['createQueue', 'setQueue', 'playNext', 'addToQueue', 'clearUpcoming']],
    ['queue edits', ['removeFromQueue', 'moveInQueue', 'setQueueCandidate', 'setQueueMode']],
    ['navigation', ['skipToNext', 'skipToPrevious', 'jumpInQueue', 'PREVIOUS_RESTART_MS']],
    ['shuffle and repeat', ['setQueueShuffle', 'setQueueRepeat', 'REPEAT_MODES', 'isRepeatMode']],
    ['reading', ['currentQueueItem', 'upcomingQueueItems', 'nextQueueItem', 'hasNextQueueItem']],
    ['randomness', ['fisherYatesShuffle', 'createSeededRandom']],
    ['restoring', ['restoreQueue', 'isQueueContext', 'QUEUE_CONTEXT_TYPES']],
    ['cleaners', ['cleanTrack', 'cleanCandidate', 'cleanSignals', 'cleanContext']],
  ])('re-exports the %s', (_group, names) => {
    for (const name of names) expect(core).toHaveProperty(name)
  })
})
