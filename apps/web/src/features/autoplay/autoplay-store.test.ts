import { formatId, type QueueItem } from '@fxm/core'
import { testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  autoplayChangeMessage,
  createAutoplayActivityStore,
  isFindingSongs,
} from './autoplay-activity'
import {
  AUTOPLAY_MARKS_STORAGE_KEY,
  AUTOPLAY_TITLE,
  autoplayContextOf,
  autoplayMarkOf,
  createAutoplayMarksStore,
  isAutoplayItem,
  MAX_AUTOPLAY_MARKS,
  sanitizeAutoplayMarks,
} from './autoplay-marks'
import {
  AUTOPLAY_STORAGE_KEY,
  createAutoplayStore,
  sanitizeAutoplay,
  syncAutoplayAcrossTabs,
} from './autoplay-store'

/** An in-memory Web Storage. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(entries))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

const blocked = (): Storage => {
  throw new DOMException('Blocked', 'SecurityError')
}

const item = (uid: number, name: string): QueueItem => ({ uid, track: testTrack(name) })
const seed = formatId('ytm', 'track', 'seed')

describe('the autoplay setting', () => {
  it('starts on', () => {
    expect(createAutoplayStore({ storage: () => memoryStorage() }).getState().enabled).toBe(true)
  })

  it('persists under its own versioned key and restores it after a reload', () => {
    const storage = memoryStorage()
    createAutoplayStore({ storage: () => storage })
      .getState()
      .setEnabled(false)
    expect(JSON.parse(storage.getItem(AUTOPLAY_STORAGE_KEY) ?? 'null')).toEqual({
      state: { enabled: false },
      version: 1,
    })
    expect(createAutoplayStore({ storage: () => storage }).getState().enabled).toBe(false)
  })

  it.each([
    ['corrupt JSON', '{"state": {"enabled": '],
    ['an array', '[false]'],
    ['a value that is not false', JSON.stringify({ state: { enabled: 'no' }, version: 1 })],
  ])('stays on after reading %s', (_case, raw) => {
    const storage = memoryStorage({ [AUTOPLAY_STORAGE_KEY]: raw })
    expect(createAutoplayStore({ storage: () => storage }).getState().enabled).toBe(true)
  })

  it('reads an older version, and works without storage', () => {
    const old = memoryStorage({
      [AUTOPLAY_STORAGE_KEY]: JSON.stringify({ state: { enabled: false }, version: 0 }),
    })
    expect(createAutoplayStore({ storage: () => old }).getState().enabled).toBe(false)
    const store = createAutoplayStore({ storage: blocked })
    store.getState().setEnabled(false)
    expect(store.getState().enabled).toBe(false)
    expect(sanitizeAutoplay(null)).toEqual({ enabled: true })
  })

  it('follows another tab', async () => {
    const store = createAutoplayStore()
    const stop = syncAutoplayAcrossTabs(store)
    localStorage.setItem(
      AUTOPLAY_STORAGE_KEY,
      JSON.stringify({ state: { enabled: false }, version: 1 }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: AUTOPLAY_STORAGE_KEY }))
    await vi.waitFor(() => expect(store.getState().enabled).toBe(false))
    stop()
    localStorage.setItem(
      AUTOPLAY_STORAGE_KEY,
      JSON.stringify({ state: { enabled: true }, version: 1 }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.getState().enabled).toBe(false)
  })
})

describe('the marks of the songs autoplay added', () => {
  it('marks items by uid, for the track they hold', () => {
    const store = createAutoplayMarksStore({ storage: () => memoryStorage() })
    const one = item(4, 'one')
    store.getState().add([{ uid: 4, trackId: one.track.id, seed }])
    const { marks } = store.getState()
    expect(isAutoplayItem(marks, one)).toBe(true)
    expect(autoplayMarkOf(marks, one)).toEqual({ trackId: one.track.id, seed })
    // The same uid holding another track, and another uid, are not marked.
    expect(isAutoplayItem(marks, item(4, 'other'))).toBe(false)
    expect(isAutoplayItem(marks, item(5, 'one'))).toBe(false)
    // Nothing inherited counts.
    expect(isAutoplayItem(marks, { uid: 'constructor' as never, track: one.track })).toBe(false)
    store.getState().add([])
    expect(store.getState().marks).toBe(marks)
  })

  it('keeps only the marks of the items still in the queue', () => {
    const store = createAutoplayMarksStore({ storage: () => memoryStorage() })
    const [a, b] = [item(1, 'a'), item(2, 'b')]
    store.getState().add([
      { uid: 1, trackId: a.track.id, seed },
      { uid: 2, trackId: b.track.id, seed },
    ])
    const before = store.getState().marks
    store.getState().keepOnly([a, b, item(3, 'c')])
    expect(store.getState().marks).toBe(before)
    store.getState().keepOnly([a, item(2, 'replaced')])
    expect(Object.keys(store.getState().marks)).toEqual(['1'])
    store.getState().clear()
    expect(store.getState().marks).toEqual({})
  })

  it('unmarks a song the user adopted by moving it', () => {
    const store = createAutoplayMarksStore({ storage: () => memoryStorage() })
    const [a, b] = [item(1, 'a'), item(2, 'b')]
    store.getState().add([
      { uid: 1, trackId: a.track.id, seed },
      { uid: 2, trackId: b.track.id, seed },
    ])
    store.getState().adopt(1)
    expect(isAutoplayItem(store.getState().marks, a)).toBe(false)
    expect(isAutoplayItem(store.getState().marks, b)).toBe(true)
    // A song autoplay didn't add changes nothing.
    const before = store.getState().marks
    store.getState().adopt(3)
    expect(store.getState().marks).toBe(before)
  })

  it('keeps the newest marks only, up to a queue’s worth', () => {
    const store = createAutoplayMarksStore({ storage: () => memoryStorage() })
    const many = Array.from({ length: MAX_AUTOPLAY_MARKS + 5 }, (_, uid) => ({
      uid,
      trackId: formatId('ytm', 'track', `t${uid}`),
      seed,
    }))
    store.getState().add(many)
    const uids = Object.keys(store.getState().marks)
    expect(uids).toHaveLength(MAX_AUTOPLAY_MARKS)
    expect(uids[0]).toBe('5')
  })

  it('persists next to the queue and reads back only valid marks', () => {
    const storage = memoryStorage()
    const one = item(7, 'one')
    createAutoplayMarksStore({ storage: () => storage })
      .getState()
      .add([{ uid: 7, trackId: one.track.id, seed }])
    expect(JSON.parse(storage.getItem(AUTOPLAY_MARKS_STORAGE_KEY) ?? 'null')).toEqual({
      state: { marks: { 7: { trackId: one.track.id, seed } } },
      version: 1,
    })
    expect(createAutoplayMarksStore({ storage: () => storage }).getState().marks).toEqual({
      7: { trackId: one.track.id, seed },
    })
    expect(
      sanitizeAutoplayMarks({
        marks: {
          1: { trackId: one.track.id, seed: formatId('ytm', 'artist', 'UC1') },
          '-1': { trackId: one.track.id, seed },
          '01': { trackId: one.track.id, seed },
          x: { trackId: one.track.id, seed },
          2: { trackId: 'nope', seed },
          3: { trackId: one.track.id, seed: 'nope' },
          4: null,
        },
      }),
    ).toEqual({ marks: { 1: { trackId: one.track.id, seed: formatId('ytm', 'artist', 'UC1') } } })
    expect(sanitizeAutoplayMarks({ marks: [1] })).toEqual({ marks: {} })
    expect(sanitizeAutoplayMarks('nope')).toEqual({ marks: {} })
  })

  it('names autoplay’s radio as where a play of a song it added started', () => {
    const one = item(9, 'one')
    const album = {
      type: 'album' as const,
      id: formatId('ytm', 'album', 'MPREb_1'),
      title: 'An album',
    }
    const marks = { 9: { trackId: one.track.id, seed } }
    expect(autoplayContextOf(one, album, marks)).toEqual({
      type: 'radio',
      seed,
      title: AUTOPLAY_TITLE,
    })
    expect(autoplayContextOf(item(10, 'two'), album, marks)).toBe(album)
    expect(autoplayContextOf(item(10, 'two'), undefined, marks)).toBeUndefined()
    // The app's marks by default.
    expect(autoplayContextOf(one, album)).toBe(album)
  })
})

describe('what autoplay is doing', () => {
  it('starts idle, and tells what it changed', () => {
    const store = createAutoplayActivityStore()
    expect(store.getState()).toEqual({ status: 'idle' })
    expect(isFindingSongs({ status: 'waiting' })).toBe(true)
    expect(isFindingSongs({ status: 'planning' })).toBe(true)
    expect(isFindingSongs({ status: 'idle' })).toBe(false)
  })

  it('says what it added or took out, for screen readers', () => {
    expect(autoplayChangeMessage({ type: 'added', titles: ['Iris Song', 'Lark Song'] })).toBe(
      'Autoplay added 2 songs, starting with Iris Song.',
    )
    expect(autoplayChangeMessage({ type: 'added', titles: ['Iris Song'] })).toBe(
      'Autoplay added Iris Song.',
    )
    expect(autoplayChangeMessage({ type: 'withdrawn', titles: ['Iris Song', 'Lark Song'] })).toBe(
      'Autoplay is off. It took out the 2 songs it added.',
    )
    expect(autoplayChangeMessage({ type: 'withdrawn', titles: ['Iris Song'] })).toBe(
      'Autoplay is off. It took out Iris Song, the song it added.',
    )
  })
})
