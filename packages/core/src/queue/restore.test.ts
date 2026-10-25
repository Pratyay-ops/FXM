import { describe, expect, it } from 'vitest'
import {
  addToQueue,
  createQueue,
  jumpTo,
  type QueueState,
  setCandidate,
  setQueue,
  setRepeat,
  setShuffle,
  skipToNext,
} from './queue'
import { createSeededRandom } from './random'
import { isQueueContext, restoreQueue } from './restore'
import { candidate, currentTitle, songs, titles, track } from './test-tracks'

type Json = Record<string, unknown>

/** `state` as it comes back from storage: plain JSON with no shared references. */
function saved(state: QueueState): Json {
  return JSON.parse(JSON.stringify(state)) as Json
}

/** A queue a, b, c, d with b current, a in the history, a candidate on c and repeat on. */
function richQueue(): QueueState {
  const state = setQueue(createQueue(), songs('a', 'b', 'c', 'd'), 0, {
    type: 'playlist',
    id: 'ytm:playlist:PL1',
    title: 'Mix',
  })
  return setRepeat(setCandidate(skipToNext(state), 2, candidate('c')), 'all')
}

/** {@link richQueue} as saved. */
function savedQueue(): Json {
  return saved(richQueue())
}

/** The saved queue with the item at `index` replaced by `item`. */
function withItem(index: number, item: unknown): Json {
  const value = savedQueue()
  ;(value.items as unknown[])[index] = item
  return value
}

/** A saved item for the song z, with `patch` applied to its track. */
function itemWithTrack(uid: number, patch: Json): Json {
  return { uid, track: { ...(JSON.parse(JSON.stringify(track('z'))) as Json), ...patch } }
}

describe('restoreQueue', () => {
  it.each([
    ['an empty queue', createQueue()],
    ['a queue with a context, history, repeat and a candidate', richQueue()],
    [
      'a shuffled queue',
      setShuffle(
        jumpTo(setQueue(createQueue(), songs(...'abcdef'), 1), 4),
        true,
        createSeededRandom(3),
      ),
    ],
    ['a Music + Video queue', setQueue(createQueue({ mode: 'all' }), [track('v', 'video')])],
  ])('restores %s exactly', (_name, state) => {
    expect(restoreQueue(saved(state))).toEqual(state)
  })

  it.each([null, undefined, 42, 'queue', [], {}, { items: 'none' }])(
    'returns null for %j',
    (value) => {
      expect(restoreQueue(value)).toBeNull()
    },
  )

  it.each([
    ['not an object', 'a'],
    ['a negative uid', { uid: -1, track: track('x') }],
    ['a fractional uid', { uid: 1.5, track: track('x') }],
    ['a missing track', { uid: 9 }],
    ['an invalid track ID', itemWithTrack(9, { id: 'nope' })],
    ['an album ID', itemWithTrack(9, { id: 'ytm:album:x' })],
    ['an unknown source', itemWithTrack(9, { source: 'napster' })],
    ['a missing title', itemWithTrack(9, { title: undefined })],
    ['artists that are not a list', itemWithTrack(9, { artists: 'Artist' })],
    ['an artist without a name', itemWithTrack(9, { artists: [{}] })],
    [
      'an artist with a track ID',
      itemWithTrack(9, { artists: [{ name: 'A', id: 'ytm:track:x' }] }),
    ],
    ['artwork that is not a list', itemWithTrack(9, { artwork: {} })],
    ['artwork without a URL', itemWithTrack(9, { artwork: [{ width: 1 }] })],
    ['artwork with a negative width', itemWithTrack(9, { artwork: [{ url: 'u', width: -1 }] })],
    ['an unknown kind', itemWithTrack(9, { kind: 'podcast' })],
    ['an inherited kind name', itemWithTrack(9, { kind: 'toString' })],
    ['an album without a name', itemWithTrack(9, { album: {} })],
    ['an album with an artist ID', itemWithTrack(9, { album: { name: 'X', id: 'ytm:artist:x' } })],
    ['a negative duration', itemWithTrack(9, { durationMs: -5 })],
    ['a duration that was NaN', itemWithTrack(9, { durationMs: null })],
  ])('drops an item with %s', (_name, item) => {
    const restored = restoreQueue(withItem(3, item))
    expect(titles(restored as QueueState)).toEqual(['a', 'b', 'c'])
  })

  it('keeps an item whose optional fields are valid', () => {
    const item = itemWithTrack(9, {
      album: { name: 'X', id: 'ytm:album:MPREb_x' },
      artists: [{ name: 'A', id: 'ytm:artist:UCx' }],
      artwork: [{ url: 'https://i.test/a.jpg', width: 60, height: 60 }],
    })
    expect(titles(restoreQueue(withItem(3, item)) as QueueState)).toEqual(['a', 'b', 'c', 'z'])
  })

  it.each([
    ['an unknown source', { source: 'napster' }],
    ['an empty ref', { ref: '' }],
    ['an unknown kind', { kind: 'clip' }],
    ['a missing title', { title: 1 }],
    ['artists that are not strings', { artists: [{ name: 'A' }] }],
    ['a confidence that is not a number', { confidence: 'high' }],
    ['a confidence that was NaN', { confidence: null }],
    ['evidence that is not a list', { evidence: 'isrc' }],
    ['a negative duration', { durationMs: -1 }],
  ])('drops only the candidate when it has %s', (_name, patch) => {
    const value = savedQueue()
    const items = value.items as Json[]
    items[2] = { ...items[2], candidate: { ...(items[2]?.candidate as Json), ...patch } }
    const restored = restoreQueue(value) as QueueState
    expect(titles(restored)).toEqual(['a', 'b', 'c', 'd'])
    expect(restored.items[2]).toEqual({ uid: 2, track: track('c') })
  })

  it('drops duplicate uids, keeping the first', () => {
    const value = savedQueue()
    const items = value.items as Json[]
    items[3] = { ...items[3], uid: 0 }
    expect(titles(restoreQueue(value) as QueueState)).toEqual(['a', 'b', 'c'])
  })

  it('applies the given mode: hidden items go, unplayable candidates are dropped', () => {
    let state = setQueue(createQueue({ mode: 'all' }), [
      track('a'),
      track('v', 'video'),
      track('m', 'music-video'),
    ])
    state = setCandidate(state, 2, candidate('m', 'music-video'))
    const restored = restoreQueue(saved(state), 'music') as QueueState
    expect(restored.mode).toBe('music')
    expect(titles(restored)).toEqual(['a', 'm'])
    expect(restored.items[1]).not.toHaveProperty('candidate')
  })

  it('uses the saved mode by default and Music when that is invalid', () => {
    const all = saved(setQueue(createQueue({ mode: 'all' }), [track('v', 'video')]))
    expect(restoreQueue(all)?.mode).toBe('all')
    expect(restoreQueue({ ...all, mode: 'video' })).toMatchObject({ mode: 'music', items: [] })
  })

  it('makes the next surviving item current when the current one was dropped', () => {
    const restored = restoreQueue(withItem(1, null)) as QueueState
    expect(currentTitle(restored)).toBe('c')
    expect(restored.history).toEqual([0])
  })

  it('falls back to the last surviving item before a dropped current item', () => {
    const value = savedQueue()
    value.items = (value.items as Json[]).slice(0, 2).concat([{ uid: 'x' }])
    value.index = 2
    expect(currentTitle(restoreQueue(value) as QueueState)).toBe('b')
  })

  it('makes an empty queue when no item survives', () => {
    expect(restoreQueue({ ...savedQueue(), items: [null] })).toMatchObject({
      items: [],
      index: -1,
      history: [],
    })
  })

  it('starts at the first item when the index is invalid', () => {
    expect(currentTitle(restoreQueue({ ...savedQueue(), index: 'one' }) as QueueState)).toBe('a')
    expect(currentTitle(restoreQueue({ ...savedQueue(), index: -1 }) as QueueState)).toBe('a')
  })

  it('repairs the history', () => {
    const restored = restoreQueue({ ...savedQueue(), history: [7, 0, 0, 1, 'a', 2.5, 3] })
    expect(restored?.history).toEqual([0, 3])
    expect(restoreQueue({ ...savedQueue(), history: 'a' })?.history).toEqual([])
  })

  it('repairs the original order of a shuffled queue', () => {
    const value = { ...savedQueue(), shuffle: true, unshuffled: [3, 9, 1, 1] }
    const restored = restoreQueue(value) as QueueState
    expect(restored.unshuffled).toEqual([3, 1, 0, 2])
    expect(titles(setShuffle(restored, false))).toEqual(['d', 'b', 'a', 'c'])
    expect(restoreQueue({ ...value, unshuffled: null })?.unshuffled).toEqual([0, 1, 2, 3])
  })

  it('drops the original order of a queue that is not shuffled', () => {
    expect(restoreQueue({ ...savedQueue(), unshuffled: [0, 1, 2, 3] })).not.toHaveProperty(
      'unshuffled',
    )
  })

  it('keeps the uid counter above every uid', () => {
    expect(restoreQueue({ ...savedQueue(), nextUid: 2 })?.nextUid).toBe(4)
    expect(restoreQueue({ ...savedQueue(), nextUid: 'x' })?.nextUid).toBe(4)
    expect(restoreQueue({ ...savedQueue(), nextUid: 10 })?.nextUid).toBe(10)
    expect(restoreQueue({ items: [] })?.nextUid).toBe(0)
    const restored = restoreQueue({ ...savedQueue(), nextUid: 0 }) as QueueState
    expect(addToQueue(restored, songs('e')).items.at(-1)?.uid).toBe(4)
  })

  it('drops an invalid context and keeps only the known context fields', () => {
    expect(
      restoreQueue({ ...savedQueue(), context: { type: 'mix', id: 'x', title: 'X' } }),
    ).not.toHaveProperty('context')
    const extra = { type: 'radio', id: 'ytm:track:a', title: 'Radio', secret: 'token' }
    expect(restoreQueue({ ...savedQueue(), context: extra })?.context).toEqual({
      type: 'radio',
      id: 'ytm:track:a',
      title: 'Radio',
    })
  })

  it('turns an invalid repeat mode off and reads shuffle strictly', () => {
    expect(restoreQueue({ ...savedQueue(), repeat: 'twice' })?.repeat).toBe('off')
    expect(restoreQueue({ ...savedQueue(), shuffle: 'yes' })?.shuffle).toBe(false)
  })

  it('fills in defaults for a bare list of items', () => {
    const items = saved(setQueue(createQueue(), songs('a', 'b'))).items
    expect(restoreQueue({ items })).toEqual(setQueue(createQueue(), songs('a', 'b')))
  })
})

describe('isQueueContext', () => {
  it.each(['album', 'playlist', 'artist', 'radio', 'search'])('accepts a %s context', (type) => {
    expect(isQueueContext({ type, id: 'x', title: 'X' })).toBe(true)
  })

  it.each([
    null,
    'album',
    { type: 'album', id: 1, title: 'X' },
    { type: 'album', id: 'x' },
    { type: 'toString', id: 'x', title: 'X' },
  ])('rejects %j', (value) => {
    expect(isQueueContext(value)).toBe(false)
  })
})
