import { describe, expect, it } from 'vitest'
import type { CatalogMode } from '../mode'
import {
  addToQueue,
  clearUpcoming,
  createQueue,
  currentItem,
  hasNextItem,
  isRepeatMode,
  jumpTo,
  moveInQueue,
  nextItem,
  PREVIOUS_RESTART_MS,
  playNext,
  type QueueContext,
  type QueueState,
  REPEAT_MODES,
  type RepeatMode,
  removeFromQueue,
  setCandidate,
  setQueue,
  setQueueMode,
  setRepeat,
  setShuffle,
  skipToNext,
  skipToPrevious,
  upcomingItems,
} from './queue'
import { createSeededRandom } from './random'
import { candidate, currentTitle, historyTitles, songs, titles, track } from './test-tracks'

const album: QueueContext = { type: 'album', id: 'ytm:album:MPREb_1', title: 'Album' }

/** A queue of songs a, b, c, … starting at `start`. */
function queueOf(names: string, start = 0, options: Parameters<typeof createQueue>[0] = {}) {
  return setQueue(createQueue(options), songs(...names.split('')), start, album)
}

/** Advances `count` times with skipToNext. */
function advance(state: QueueState, count: number): QueueState {
  let next = state
  for (let i = 0; i < count; i += 1) next = skipToNext(next)
  return next
}

describe('createQueue', () => {
  it('starts empty with Music mode, no repeat and no shuffle', () => {
    expect(createQueue()).toEqual({
      items: [],
      index: -1,
      history: [],
      mode: 'music',
      repeat: 'off',
      shuffle: false,
      nextUid: 0,
    })
  })

  it('takes the mode, repeat and shuffle settings', () => {
    expect(createQueue({ mode: 'all', repeat: 'one', shuffle: true })).toMatchObject({
      mode: 'all',
      repeat: 'one',
      shuffle: true,
      unshuffled: [],
    })
  })

  it('falls back to the defaults for invalid settings', () => {
    const queue = createQueue({ mode: 'video' as CatalogMode, repeat: 'twice' as RepeatMode })
    expect(queue).toMatchObject({ mode: 'music', repeat: 'off', shuffle: false })
  })

  it('is plain JSON data', () => {
    const queue = setShuffle(queueOf('abc', 1), true, createSeededRandom(1))
    expect(JSON.parse(JSON.stringify(queue))).toEqual(queue)
  })
})

describe('isRepeatMode', () => {
  it.each(REPEAT_MODES)('accepts %s', (mode) => {
    expect(isRepeatMode(mode)).toBe(true)
  })

  it.each([undefined, null, 1, 'ALL', 'toString'])('rejects %j', (value) => {
    expect(isRepeatMode(value)).toBe(false)
  })
})

describe('setQueue', () => {
  it('queues the tracks in order and starts at startIndex', () => {
    const queue = queueOf('abcd', 2)
    expect(titles(queue)).toEqual(['a', 'b', 'c', 'd'])
    expect(currentTitle(queue)).toBe('c')
    expect(queue.items.map((item) => item.uid)).toEqual([0, 1, 2, 3])
    expect(queue.nextUid).toBe(4)
    expect(queue.context).toEqual(album)
    expect(queue.history).toEqual([])
  })

  it.each([
    [-5, 'a'],
    [99, 'c'],
    [1.7, 'b'],
    [Number.NaN, 'a'],
    [Number.POSITIVE_INFINITY, 'c'],
  ])('clamps the start index %s to %s', (start, expected) => {
    expect(currentTitle(queueOf('abc', start))).toBe(expected)
  })

  it('starts at the first track by default', () => {
    expect(currentTitle(setQueue(createQueue(), songs('a', 'b')))).toBe('a')
  })

  it('leaves out tracks the mode hides and keeps music videos for song matching', () => {
    const tracks = [
      track('a'),
      track('v', 'video'),
      track('m', 'music-video'),
      track('e', 'episode'),
    ]
    expect(titles(setQueue(createQueue(), tracks))).toEqual(['a', 'm'])
    expect(titles(setQueue(createQueue({ mode: 'all' }), tracks))).toEqual(['a', 'v', 'm'])
  })

  it('starts at the next kept track when the start track is hidden', () => {
    const tracks = [track('a'), track('v', 'video'), track('b')]
    expect(currentTitle(setQueue(createQueue(), tracks, 1))).toBe('b')
  })

  it('starts at the last kept track before a hidden start with nothing after it', () => {
    const tracks = [track('a'), track('b'), track('v', 'video')]
    expect(currentTitle(setQueue(createQueue(), tracks, 2))).toBe('b')
  })

  it('makes an empty queue when the mode hides every track', () => {
    const queue = setQueue(createQueue(), [track('v', 'video')], 0, album)
    expect(queue).toMatchObject({ items: [], index: -1, context: album })
    expect(setQueue(createQueue({ shuffle: true }), [], 0)).toMatchObject({
      items: [],
      index: -1,
      unshuffled: [],
    })
  })

  it('replaces the previous queue, its history and its context', () => {
    const played = advance(queueOf('abc'), 2)
    const queue = setQueue(played, songs('x', 'y'))
    expect(titles(queue)).toEqual(['x', 'y'])
    expect(queue.history).toEqual([])
    expect(queue).not.toHaveProperty('context')
    expect(queue.items.map((item) => item.uid)).toEqual([3, 4])
  })

  it('keeps the repeat, shuffle and mode settings', () => {
    const settings = setRepeat(createQueue({ mode: 'all', shuffle: true }), 'all')
    expect(setQueue(settings, songs('a', 'b'))).toMatchObject({
      mode: 'all',
      repeat: 'all',
      shuffle: true,
    })
  })

  it('puts the start track first and shuffles the rest while shuffle is on', () => {
    const queue = setQueue(
      createQueue({ shuffle: true }),
      songs('a', 'b', 'c', 'd', 'e', 'f'),
      3,
      album,
      createSeededRandom(7),
    )
    expect(currentTitle(queue)).toBe('d')
    expect(queue.index).toBe(0)
    expect([...titles(queue)].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(titles(queue)).not.toEqual(['d', 'a', 'b', 'c', 'e', 'f'])
    expect(queue.unshuffled).toEqual([0, 1, 2, 3, 4, 5])
    expect(titles(setShuffle(queue, false))).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('shuffles the same way for the same seed', () => {
    const shuffled = (seed: number) =>
      titles(
        setQueue(
          createQueue({ shuffle: true }),
          songs(...'abcdefgh'),
          0,
          album,
          createSeededRandom(seed),
        ),
      )
    expect(shuffled(3)).toEqual(shuffled(3))
    expect(shuffled(3)).not.toEqual(shuffled(4))
  })
})

describe('playNext', () => {
  it('inserts the tracks right after the current item, in order', () => {
    const queue = playNext(queueOf('abc', 1), songs('x', 'y'))
    expect(titles(queue)).toEqual(['a', 'b', 'x', 'y', 'c'])
    expect(currentTitle(queue)).toBe('b')
    expect(queue.nextUid).toBe(5)
  })

  it('plays the most recent "play next" first', () => {
    const queue = playNext(playNext(queueOf('ab'), songs('x')), songs('y'))
    expect(titles(queue)).toEqual(['a', 'y', 'x', 'b'])
  })

  it('makes the first track current on an empty queue', () => {
    const queue = playNext(createQueue(), songs('x', 'y'))
    expect(titles(queue)).toEqual(['x', 'y'])
    expect(queue.index).toBe(0)
  })

  it('leaves out hidden tracks and changes nothing when all are hidden', () => {
    const queue = queueOf('ab')
    expect(titles(playNext(queue, [track('v', 'video'), track('x')]))).toEqual(['a', 'x', 'b'])
    expect(playNext(queue, [track('v', 'video')])).toBe(queue)
    expect(playNext(queue, [])).toBe(queue)
  })

  it('keeps the inserted tracks after the current item when shuffle turns off', () => {
    const shuffled = setShuffle(queueOf('abcde', 2), true, createSeededRandom(2))
    const queue = playNext(shuffled, songs('x', 'y'))
    expect(titles(queue).slice(0, 3)).toEqual(['c', 'x', 'y'])
    expect(titles(setShuffle(queue, false))).toEqual(['a', 'b', 'c', 'x', 'y', 'd', 'e'])
  })

  it('records the original order on an empty shuffled queue', () => {
    const queue = playNext(createQueue({ shuffle: true }), songs('x', 'y'))
    expect(queue.unshuffled).toEqual([0, 1])
    expect(titles(queue)).toEqual(['x', 'y'])
  })
})

describe('addToQueue', () => {
  it('appends the tracks to the end', () => {
    const queue = addToQueue(queueOf('ab'), songs('x', 'y'))
    expect(titles(queue)).toEqual(['a', 'b', 'x', 'y'])
    expect(currentTitle(queue)).toBe('a')
  })

  it('makes the first track current on an empty queue', () => {
    expect(addToQueue(createQueue(), songs('x')).index).toBe(0)
  })

  it('leaves out hidden tracks and changes nothing when all are hidden', () => {
    const queue = queueOf('a')
    expect(titles(addToQueue(queue, [track('x'), track('e', 'episode')]))).toEqual(['a', 'x'])
    expect(addToQueue(queue, [track('e', 'episode')])).toBe(queue)
  })

  it('appends to the original order too while shuffle is on', () => {
    const shuffled = setShuffle(queueOf('abc'), true, createSeededRandom(5))
    const queue = addToQueue(shuffled, songs('x'))
    expect(currentTitle(queue)).toBe('a')
    expect(titles(queue).at(-1)).toBe('x')
    expect(titles(setShuffle(queue, false))).toEqual(['a', 'b', 'c', 'x'])
  })
})

describe('removeFromQueue', () => {
  it('keeps the current item when an earlier item goes', () => {
    const queue = removeFromQueue(queueOf('abcd', 2), 0)
    expect(titles(queue)).toEqual(['b', 'c', 'd'])
    expect(currentTitle(queue)).toBe('c')
  })

  it('keeps the current item when a later item goes', () => {
    const queue = removeFromQueue(queueOf('abcd', 1), 3)
    expect(titles(queue)).toEqual(['a', 'b', 'c'])
    expect(currentTitle(queue)).toBe('b')
  })

  it('makes the following item current when the current one goes', () => {
    expect(currentTitle(removeFromQueue(queueOf('abc', 1), 1))).toBe('c')
  })

  it('makes the preceding item current when the current one was last', () => {
    expect(currentTitle(removeFromQueue(queueOf('abc', 2), 2))).toBe('b')
  })

  it('empties the queue when the only item goes', () => {
    expect(removeFromQueue(queueOf('a'), 0)).toMatchObject({ items: [], index: -1 })
  })

  it.each([-1, 3, 1.5, Number.NaN])('ignores the invalid index %s', (index) => {
    const queue = queueOf('abc')
    expect(removeFromQueue(queue, index)).toBe(queue)
  })

  it('removes the item from the history and from the original order', () => {
    const shuffled = setShuffle(advance(queueOf('abcd'), 2), true, createSeededRandom(1))
    expect(historyTitles(shuffled)).toEqual(['a', 'b'])
    const queue = removeFromQueue(
      shuffled,
      shuffled.items.findIndex((i) => i.track.title === 'a'),
    )
    expect(historyTitles(queue)).toEqual(['b'])
    expect(titles(setShuffle(queue, false))).toEqual(['b', 'c', 'd'])
  })

  it('takes the new current item out of the history', () => {
    // a is current and b, c are in the history after going back twice.
    let queue = advance(queueOf('abc'), 2)
    queue = skipToPrevious(skipToPrevious(queue))
    expect(currentTitle(queue)).toBe('a')
    expect(historyTitles(queue)).toEqual(['c', 'b'])
    queue = removeFromQueue(queue, 0)
    expect(currentTitle(queue)).toBe('b')
    expect(historyTitles(queue)).toEqual(['c'])
  })
})

describe('moveInQueue', () => {
  it('moves an item and keeps the current one current', () => {
    const queue = moveInQueue(queueOf('abcd', 1), 3, 0)
    expect(titles(queue)).toEqual(['d', 'a', 'b', 'c'])
    expect(currentTitle(queue)).toBe('b')
    expect(queue.index).toBe(2)
  })

  it('moves the current item', () => {
    const queue = moveInQueue(queueOf('abcd', 0), 0, 2)
    expect(titles(queue)).toEqual(['b', 'c', 'a', 'd'])
    expect(queue.index).toBe(2)
  })

  it.each([
    [0, 0],
    [-1, 1],
    [1, 4],
    [0.5, 1],
  ])('ignores the move from %s to %s', (from, to) => {
    const queue = queueOf('abcd')
    expect(moveInQueue(queue, from, to)).toBe(queue)
  })

  it('changes only the play order while shuffle is on', () => {
    const shuffled = setShuffle(queueOf('abcd'), true, createSeededRandom(9))
    const queue = moveInQueue(shuffled, 3, 1)
    expect(queue.unshuffled).toEqual(shuffled.unshuffled)
    expect(titles(setShuffle(queue, false))).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('clearUpcoming', () => {
  it('removes everything after the current item', () => {
    const queue = clearUpcoming(queueOf('abcd', 1))
    expect(titles(queue)).toEqual(['a', 'b'])
    expect(currentTitle(queue)).toBe('b')
  })

  it('changes nothing at the last item or on an empty queue', () => {
    const last = queueOf('ab', 1)
    expect(clearUpcoming(last)).toBe(last)
    const empty = createQueue()
    expect(clearUpcoming(empty)).toBe(empty)
  })

  it('prunes the history and the original order', () => {
    let queue = advance(queueOf('abcd'), 3)
    queue = jumpTo(queue, 1)
    expect(historyTitles(queue)).toEqual(['a', 'c', 'd'])
    queue = setShuffle(queue, true, createSeededRandom(4))
    queue = clearUpcoming(jumpTo(queue, 0))
    expect(currentTitle(queue)).toBe('a')
    expect(titles(queue)).toEqual(['a'])
    expect(queue.history).toEqual([])
    expect(queue.unshuffled).toEqual([0])
  })
})

describe('skipToNext', () => {
  it('moves to the next item and records the history', () => {
    const queue = advance(queueOf('abc'), 2)
    expect(currentTitle(queue)).toBe('c')
    expect(historyTitles(queue)).toEqual(['a', 'b'])
  })

  it('stops at the last item when repeat is off', () => {
    const last = queueOf('ab', 1)
    expect(hasNextItem(last)).toBe(false)
    expect(nextItem(last)).toBeUndefined()
    expect(skipToNext(last)).toBe(last)
  })

  it.each(['all', 'one'] as const)('wraps to the first item with repeat %s', (repeat) => {
    const last = setRepeat(queueOf('abc', 2), repeat)
    expect(hasNextItem(last)).toBe(true)
    expect(nextItem(last)?.track.title).toBe('a')
    const queue = skipToNext(last)
    expect(currentTitle(queue)).toBe('a')
    expect(historyTitles(queue)).toEqual(['c'])
  })

  it('stays on the only item of a repeating queue', () => {
    const single = setRepeat(queueOf('a'), 'all')
    const queue = skipToNext(single)
    expect(queue.index).toBe(0)
    expect(queue.history).toEqual([])
  })

  it('changes nothing on an empty queue', () => {
    const empty = setRepeat(createQueue(), 'all')
    expect(skipToNext(empty)).toBe(empty)
    expect(hasNextItem(empty)).toBe(false)
  })

  it('keeps each item once in the history, most recent last', () => {
    let queue = setRepeat(queueOf('ab'), 'all')
    queue = advance(queue, 3)
    expect(currentTitle(queue)).toBe('b')
    expect(historyTitles(queue)).toEqual(['a'])
  })
})

describe('skipToPrevious', () => {
  it('goes back to the previous item early in the track', () => {
    const queue = skipToPrevious(queueOf('abc', 2), 1200)
    expect(currentTitle(queue)).toBe('b')
    expect(historyTitles(queue)).toEqual(['c'])
  })

  it('goes back at exactly the restart threshold', () => {
    expect(PREVIOUS_RESTART_MS).toBe(3000)
    expect(currentTitle(skipToPrevious(queueOf('ab', 1), 3000))).toBe('a')
  })

  it('restarts the current item (no change) after the threshold', () => {
    const queue = queueOf('ab', 1)
    expect(skipToPrevious(queue, 3001)).toBe(queue)
  })

  it('goes back by default', () => {
    expect(currentTitle(skipToPrevious(queueOf('ab', 1)))).toBe('a')
  })

  it('restarts at the first item when repeat is off', () => {
    const first = queueOf('abc')
    expect(skipToPrevious(first, 0)).toBe(first)
  })

  it('wraps to the last item when repeat is on', () => {
    expect(currentTitle(skipToPrevious(setRepeat(queueOf('abc'), 'all'), 0))).toBe('c')
    expect(currentTitle(skipToPrevious(setRepeat(queueOf('abc'), 'one'), 0))).toBe('c')
  })

  it('restarts the only item of a repeating queue', () => {
    const single = setRepeat(queueOf('a'), 'all')
    expect(skipToPrevious(single, 0)).toBe(single)
  })

  it('changes nothing on an empty queue', () => {
    const empty = createQueue()
    expect(skipToPrevious(empty, 0)).toBe(empty)
  })
})

describe('jumpTo', () => {
  it('makes the item current and records the history', () => {
    const queue = jumpTo(queueOf('abcd'), 3)
    expect(currentTitle(queue)).toBe('d')
    expect(historyTitles(queue)).toEqual(['a'])
    expect(currentTitle(skipToPrevious(queue))).toBe('c')
  })

  it.each([0, -1, 4, 2.5])('ignores the index %s', (index) => {
    const queue = queueOf('abcd')
    expect(jumpTo(queue, index)).toBe(queue)
  })
})

describe('setShuffle', () => {
  it('keeps what played before the current item and shuffles the rest after it', () => {
    let queue = advance(queueOf('abcdefgh'), 2)
    queue = setShuffle(queue, true, createSeededRandom(11))
    expect(titles(queue).slice(0, 3)).toEqual(['a', 'b', 'c'])
    expect(queue.index).toBe(2)
    expect([...titles(queue).slice(3)].sort()).toEqual(['d', 'e', 'f', 'g', 'h'])
    expect(currentTitle(skipToPrevious(queue))).toBe('b')
  })

  it('shuffles skipped items in with the unplayed ones', () => {
    let queue = jumpTo(queueOf('abcdef'), 4)
    queue = setShuffle(queue, true, createSeededRandom(3))
    expect(titles(queue).slice(0, 2)).toEqual(['a', 'e'])
    expect([...titles(queue).slice(2)].sort()).toEqual(['b', 'c', 'd', 'f'])
  })

  it('puts played items in the order they played', () => {
    let queue = jumpTo(queueOf('abcdef'), 4)
    queue = jumpTo(queue, 1)
    queue = setShuffle(queue, true, createSeededRandom(3))
    expect(titles(queue).slice(0, 3)).toEqual(['a', 'e', 'b'])
    expect(queue.index).toBe(2)
  })

  it('restores the original order and keeps the current item when turned off', () => {
    const start = queueOf('abcdefgh', 3)
    let queue = setShuffle(start, true, createSeededRandom(5))
    queue = advance(queue, 3)
    const playing = currentTitle(queue)
    queue = setShuffle(queue, false)
    expect(titles(queue)).toEqual(titles(start))
    expect(currentTitle(queue)).toBe(playing)
    expect(queue).not.toHaveProperty('unshuffled')
    expect(queue.shuffle).toBe(false)
  })

  it('changes nothing when the setting is already applied', () => {
    const queue = queueOf('abc')
    expect(setShuffle(queue, false)).toBe(queue)
    const shuffled = setShuffle(queue, true)
    expect(setShuffle(shuffled, true)).toBe(shuffled)
  })

  it('turns on and off on an empty queue', () => {
    const on = setShuffle(createQueue(), true)
    expect(on).toMatchObject({ shuffle: true, unshuffled: [], index: -1 })
    expect(setShuffle(on, false)).toEqual(createQueue())
  })

  it('uses Math.random by default', () => {
    const queue = setShuffle(queueOf('abcdef'), true)
    expect([...titles(queue)].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(currentTitle(queue)).toBe('a')
  })
})

describe('setRepeat', () => {
  it('sets the repeat mode', () => {
    expect(setRepeat(queueOf('a'), 'one').repeat).toBe('one')
  })

  it('changes nothing for the same or an invalid mode', () => {
    const queue = queueOf('a')
    expect(setRepeat(queue, 'off')).toBe(queue)
    expect(setRepeat(queue, 'twice' as RepeatMode)).toBe(queue)
  })
})

describe('setQueueMode', () => {
  const mixed = [track('a'), track('v', 'video'), track('m', 'music-video'), track('b')]

  it('removes the items Music mode hides but keeps the current one', () => {
    let queue = setQueue(createQueue({ mode: 'all' }), mixed, 0)
    queue = setQueueMode(queue, 'music')
    expect(queue.mode).toBe('music')
    expect(titles(queue)).toEqual(['a', 'm', 'b'])
    queue = setQueueMode(setQueue(createQueue({ mode: 'all' }), mixed, 1), 'music')
    expect(titles(queue)).toEqual(['a', 'v', 'm', 'b'])
    expect(currentTitle(queue)).toBe('v')
  })

  it('drops a hidden current item once another item becomes current', () => {
    const kept = setQueueMode(setQueue(createQueue({ mode: 'all' }), mixed, 1), 'music')
    let queue = skipToNext(kept)
    expect(titles(queue)).toEqual(['a', 'm', 'b'])
    expect(currentTitle(queue)).toBe('m')
    expect(queue.history).toEqual([])
    queue = skipToPrevious(kept)
    expect(titles(queue)).toEqual(['a', 'm', 'b'])
    expect(currentTitle(queue)).toBe('a')
    queue = jumpTo(setShuffle(kept, true, createSeededRandom(1)), 3)
    expect(titles(queue)).not.toContain('v')
    expect(queue.unshuffled).toEqual([0, 2, 3])
  })

  it('drops hidden items from the history and the original order', () => {
    let queue = setQueue(createQueue({ mode: 'all' }), mixed, 0)
    queue = setShuffle(advance(queue, 2), true, createSeededRandom(8))
    expect(historyTitles(queue)).toEqual(['a', 'v'])
    queue = setQueueMode(queue, 'music')
    expect(historyTitles(queue)).toEqual(['a'])
    expect(titles(setShuffle(queue, false))).toEqual(['a', 'm', 'b'])
  })

  it('drops candidates the new mode does not let play', () => {
    let queue = setQueue(createQueue({ mode: 'all' }), [track('m', 'music-video'), track('a')])
    queue = setCandidate(queue, 0, candidate('m', 'music-video'))
    queue = setCandidate(queue, 1, candidate('a'))
    queue = setQueueMode(queue, 'music')
    expect(queue.items[0]).not.toHaveProperty('candidate')
    expect(queue.items[1]?.candidate?.ref).toBe('a')
  })

  it('keeps everything when the new mode shows more', () => {
    const queue = setQueue(createQueue(), [track('a'), track('m', 'music-video')])
    expect(titles(setQueueMode(queue, 'all'))).toEqual(['a', 'm'])
  })

  it('changes nothing for the same mode and treats an unknown mode as Music', () => {
    const queue = setQueue(createQueue({ mode: 'all' }), mixed, 0)
    expect(setQueueMode(queue, 'all')).toBe(queue)
    expect(titles(setQueueMode(queue, 'everything' as CatalogMode))).toEqual(['a', 'm', 'b'])
    const music = createQueue()
    expect(setQueueMode(music, 'everything' as CatalogMode)).toBe(music)
  })

  it('switches an empty queue', () => {
    expect(setQueueMode(createQueue(), 'all')).toMatchObject({ mode: 'all', index: -1 })
  })
})

describe('setCandidate', () => {
  it('records and clears the chosen candidate', () => {
    const queue = setCandidate(queueOf('ab'), 1, candidate('b'))
    expect(queue.items[1]?.candidate).toEqual(candidate('b'))
    expect(queue.items[1]?.track.title).toBe('b')
    const cleared = setCandidate(queue, 1)
    expect(cleared.items[1]).toEqual({ uid: 1, track: track('b') })
  })

  it('maps a music video to its song in Music mode', () => {
    const queue = setQueue(createQueue(), [track('m', 'music-video')])
    expect(setCandidate(queue, 0, candidate('song-of-m')).items[0]?.candidate?.kind).toBe('song')
  })

  it('ignores an unknown uid, the same candidate and one the mode does not let play', () => {
    const chosen = candidate('a')
    const queue = setCandidate(queueOf('a'), 0, chosen)
    expect(setCandidate(queue, 42, candidate('x'))).toBe(queue)
    expect(setCandidate(queue, 0, chosen)).toBe(queue)
    expect(setCandidate(queue, 0, candidate('v', 'video'))).toBe(queue)
    const plain = queueOf('a')
    expect(setCandidate(plain, 0)).toBe(plain)
  })
})

describe('reading the queue', () => {
  it('returns the current, upcoming and next items', () => {
    const queue = queueOf('abcd', 1)
    expect(currentItem(queue)?.track.title).toBe('b')
    expect(upcomingItems(queue).map((item) => item.track.title)).toEqual(['c', 'd'])
    expect(nextItem(queue)?.track.title).toBe('c')
    expect(hasNextItem(queue)).toBe(true)
  })

  it('has nothing current or upcoming when empty', () => {
    const empty = createQueue()
    expect(currentItem(empty)).toBeUndefined()
    expect(upcomingItems(empty)).toEqual([])
    expect(nextItem(empty)).toBeUndefined()
  })

  it('has a one-item repeating queue come back to its only item', () => {
    const single = setRepeat(queueOf('a'), 'all')
    expect(nextItem(single)?.uid).toBe(currentItem(single)?.uid)
  })
})

describe('states built by hand', () => {
  it('turns shuffle off without a complete original order, keeping unlisted items last', () => {
    const partial: QueueState = { ...queueOf('abc', 1), shuffle: true, unshuffled: [2, 0] }
    const restored = setShuffle(partial, false)
    expect(titles(restored)).toEqual(['c', 'a', 'b'])
    expect(currentTitle(restored)).toBe('b')
    const missing: QueueState = { ...queueOf('abc', 1), shuffle: true }
    expect(titles(setShuffle(missing, false))).toEqual(['a', 'b', 'c'])
  })

  it('ignores history entries for items that are not queued', () => {
    const stale: QueueState = { ...queueOf('abc', 1), history: [42, 0, 1] }
    const shuffled = setShuffle(stale, true, createSeededRandom(1))
    expect(titles(shuffled).slice(0, 2)).toEqual(['a', 'b'])
    expect(shuffled.index).toBe(1)
  })
})
