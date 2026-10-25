import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { Track } from '../model'
import {
  addToQueue,
  createQueue,
  jumpInQueue,
  type QueueState,
  setQueue,
  setQueueCandidate,
  setQueueRepeat,
  setQueueShuffle,
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

/** A queue a, b, c, d with b current, a played, a candidate on c and repeat on. */
function richQueue(): QueueState {
  const state = setQueue(createQueue(), songs('a', 'b', 'c', 'd'), {
    context: { type: 'playlist', id: formatId('ytm', 'playlist', 'PL1'), title: 'Mix' },
  })
  return setQueueRepeat(setQueueCandidate(skipToNext(state), 2, candidate('c')), 'all')
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

/** The track of the item restored from `itemWithTrack(9, patch)`, appended to the saved queue. */
function restoredTrack(patch: Json): Track | undefined {
  const restored = restoreQueue(withItem(3, itemWithTrack(9, patch))) as QueueState
  return restored.items.find((item) => item.uid === 9)?.track
}

/** A fully filled-in track: every optional field set to a valid value. */
const fullTrack: Track = {
  ...track('full'),
  artists: [{ id: formatId('ytm', 'artist', 'UCx'), name: 'A' }],
  album: { id: formatId('ytm', 'album', 'MPREb_x'), name: 'X' },
  artwork: [{ url: 'https://i.test/a.jpg', width: 60, height: 60 }],
  explicit: true,
  isrc: 'GBARL9300135',
  kind: 'music-video',
  songId: formatId('ytm', 'track', 'song'),
  trackNumber: 3,
  discNumber: 1,
  releaseDate: '2013-05-17',
  popularity: 72,
  externalIds: { spotify: '4uLU6hMCjMI75M1A2tKUQC' },
}

describe('restoreQueue', () => {
  it.each([
    ['an empty queue', createQueue()],
    ['a queue with a context, played items, repeat and a candidate', richQueue()],
    [
      'a shuffled queue',
      setQueueShuffle(
        jumpInQueue(setQueue(createQueue(), songs(...'abcdef'), { startIndex: 1 }), 4),
        true,
        createSeededRandom(3),
      ),
    ],
    ['a Music + Video queue', setQueue(createQueue({ mode: 'all' }), [track('v', 'video')])],
    [
      'a queue with every optional field',
      setQueueCandidate(setQueue(createQueue({ mode: 'all' }), [fullTrack]), 0, {
        ...candidate('full'),
        durationMs: 200_000,
        signals: {
          isrcVerified: true,
          releaseId: 'MPREb_x',
          releaseYear: 2013,
          label: 'Label',
          sourceAlbumMatch: false,
        },
      }),
    ],
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
    ['a source that is not the ID source', itemWithTrack(9, { source: 'spotify' })],
    ['a missing title', itemWithTrack(9, { title: undefined })],
    ['artists that are not a list', itemWithTrack(9, { artists: 'Artist' })],
    ['an artist without a name', itemWithTrack(9, { artists: [{}] })],
    ['artwork that is not a list', itemWithTrack(9, { artwork: {} })],
    ['artwork without a URL', itemWithTrack(9, { artwork: [{ width: 1 }] })],
    ['an unknown kind', itemWithTrack(9, { kind: 'podcast' })],
    ['an inherited kind name', itemWithTrack(9, { kind: 'toString' })],
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
    ['durationMs', -5],
    ['durationMs', null],
    ['explicit', 'yes'],
    ['isrc', 'not an isrc'],
    ['isrc', 42],
    ['songId', 'ytm:album:x'],
    ['trackNumber', 0],
    ['trackNumber', 2.5],
    ['discNumber', '1'],
    ['releaseDate', '17 May 2013'],
    ['releaseDate', '2013-13'],
    ['popularity', 101],
    ['popularity', -1],
    ['externalIds', 'spotify:x'],
    ['externalIds', { napster: 'x', spotify: '' }],
    ['album', { id: 'ytm:album:x' }],
    ['album', 'X'],
  ])('drops only a malformed optional %s (%j) and keeps the item', (key, value) => {
    const restored = restoredTrack({ [key]: value })
    expect(restored?.title).toBe('z')
    expect(restored).not.toHaveProperty(key)
  })

  it('drops malformed optional parts of artists, the album and artwork', () => {
    const restored = restoredTrack({
      artists: [{ name: 'A', id: 'ytm:track:x' }],
      album: { name: 'X', id: 'ytm:artist:x' },
      artwork: [{ url: 'u', width: -1, height: '60' }],
    })
    expect(restored?.artists).toEqual([{ name: 'A' }])
    expect(restored?.album).toEqual({ name: 'X' })
    expect(restored?.artwork).toEqual([{ url: 'u' }])
  })

  it('copies only known fields and keeps only valid external IDs', () => {
    const restored = restoredTrack({
      secret: 'token',
      externalIds: { spotify: 'abc', napster: 'x', archive: 7 },
      artists: [{ name: 'A', role: 'admin' }],
    })
    expect(restored).not.toHaveProperty('secret')
    expect(restored?.externalIds).toEqual({ spotify: 'abc' })
    expect(restored?.artists).toEqual([{ name: 'A' }])
  })

  it('stores an ISRC in its canonical form', () => {
    expect(restoredTrack({ isrc: 'gb-arl-93-00135' })?.isrc).toBe('GBARL9300135')
  })

  it.each([
    ['an unknown source', { source: 'napster' }],
    ['an empty ref', { ref: '' }],
    ['an unknown kind', { kind: 'clip' }],
    ['a missing title', { title: 1 }],
    ['artists that are not strings', { artists: [{ name: 'A' }] }],
    ['a confidence that is not a number', { confidence: 'high' }],
    ['a confidence that was NaN', { confidence: null }],
    ['a confidence above 1', { confidence: 1.5 }],
    ['evidence that is not a list', { evidence: 'isrc' }],
  ])('drops only the candidate when it has %s', (_name, patch) => {
    const value = savedQueue()
    const items = value.items as Json[]
    items[2] = { ...items[2], candidate: { ...(items[2]?.candidate as Json), ...patch } }
    const restored = restoreQueue(value) as QueueState
    expect(titles(restored)).toEqual(['a', 'b', 'c', 'd'])
    expect(restored.items[2]).toEqual({ uid: 2, track: track('c') })
  })

  it('drops malformed optional parts of a candidate and copies only known fields', () => {
    const value = savedQueue()
    const items = value.items as Json[]
    items[2] = {
      ...items[2],
      candidate: {
        ...(items[2]?.candidate as Json),
        durationMs: -1,
        url: 'https://evil.test',
        signals: { isrcVerified: true, sourceAlbumMatch: false, releaseYear: 'x', label: 3 },
      },
    }
    const restored = restoreQueue(value) as QueueState
    expect(restored.items[2]?.candidate).toEqual({
      ...candidate('c'),
      signals: { isrcVerified: true, sourceAlbumMatch: false },
    })
    items[2] = {
      ...items[2],
      candidate: { ...candidate('c'), signals: { isrcVerified: 'yes', sourceAlbumMatch: false } },
    }
    expect((restoreQueue(value) as QueueState).items[2]?.candidate).toEqual(candidate('c'))
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
    state = setQueueCandidate(state, 2, candidate('m', 'music-video'))
    const restored = restoreQueue(saved(state), 'music') as QueueState
    expect(restored.mode).toBe('music')
    expect(titles(restored)).toEqual(['a', 'm'])
    expect(restored.items[1]).not.toHaveProperty('candidate')
  })

  it('drops a hidden current item instead of keeping it', () => {
    const state = setQueue(createQueue({ mode: 'all' }), [track('v', 'video'), track('a')])
    const restored = restoreQueue(saved(state), 'music') as QueueState
    expect(titles(restored)).toEqual(['a'])
    expect(currentTitle(restored)).toBe('a')
  })

  it('uses the saved mode by default and Music when that is invalid', () => {
    const all = saved(setQueue(createQueue({ mode: 'all' }), [track('v', 'video')]))
    expect(restoreQueue(all)?.mode).toBe('all')
    expect(restoreQueue({ ...all, mode: 'video' })).toMatchObject({ mode: 'music', items: [] })
  })

  it('makes the next surviving item current when the current one was dropped', () => {
    const restored = restoreQueue(withItem(1, null)) as QueueState
    expect(currentTitle(restored)).toBe('c')
    expect(restored.playedUids).toEqual([0])
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
      playedUids: [],
    })
  })

  it('starts at the first item when the index is invalid', () => {
    expect(currentTitle(restoreQueue({ ...savedQueue(), index: 'one' }) as QueueState)).toBe('a')
    expect(currentTitle(restoreQueue({ ...savedQueue(), index: -1 }) as QueueState)).toBe('a')
  })

  it('repairs the played items', () => {
    const restored = restoreQueue({ ...savedQueue(), playedUids: [7, 0, 0, 1, 'a', 2.5, 3] })
    expect(restored?.playedUids).toEqual([0, 3])
    expect(restoreQueue({ ...savedQueue(), playedUids: 'a' })?.playedUids).toEqual([])
  })

  it('repairs the original order of a shuffled queue', () => {
    const value = { ...savedQueue(), shuffle: true, unshuffled: [3, 9, 1, 1] }
    const restored = restoreQueue(value) as QueueState
    expect(restored.unshuffled).toEqual([3, 1, 0, 2])
    expect(titles(setQueueShuffle(restored, false))).toEqual(['d', 'b', 'a', 'c'])
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
    const extra = { type: 'radio', seed: 'ytm:track:a', title: 'Radio', secret: 'token' }
    expect(restoreQueue({ ...savedQueue(), context: extra })?.context).toEqual({
      type: 'radio',
      seed: 'ytm:track:a',
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
  it.each([
    { type: 'album', id: 'ytm:album:MPREb_x', title: 'X' },
    { type: 'playlist', id: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', title: 'X' },
    { type: 'artist', id: 'ytm:artist:UCx', title: 'X' },
    { type: 'radio', seed: 'ytm:track:a', title: 'X' },
    { type: 'radio', seed: 'spotify:artist:0OdUWJ0sBjDrqHygGUXeCF', title: 'X' },
    { type: 'search', query: 'blue', title: 'blue' },
    { type: 'library', id: 'liked', title: 'Liked songs' },
  ])('accepts %j', (value) => {
    expect(isQueueContext(value)).toBe(true)
  })

  it.each([
    null,
    'album',
    { type: 'album', id: 1, title: 'X' },
    { type: 'album', id: 'x', title: 'X' },
    { type: 'album', id: 'ytm:playlist:x', title: 'X' },
    { type: 'album', id: 'ytm:album:x' },
    { type: 'playlist', id: 'ytm:album:x', title: 'X' },
    { type: 'artist', id: 'ytm:track:x', title: 'X' },
    { type: 'radio', id: 'ytm:track:a', title: 'X' },
    { type: 'radio', seed: 'ytm:album:a', title: 'X' },
    { type: 'search', id: 'blue', title: 'X' },
    { type: 'library', id: '', title: 'X' },
    { type: 'toString', id: 'x', title: 'X' },
  ])('rejects %j', (value) => {
    expect(isQueueContext(value)).toBe(false)
  })
})
