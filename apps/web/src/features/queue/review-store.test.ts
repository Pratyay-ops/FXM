import { testTrack } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { spotifyTrack, testCandidate } from '../now-playing/testing'
import {
  cleanCandidate,
  createQueueReviewStore,
  REVIEW_STORAGE_KEY,
  sanitizeReview,
} from './review-store'

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
      data.set(key, value)
    },
  }
}

describe('queue review store', () => {
  it('starts empty, with "Play best guesses" off', () => {
    const store = createQueueReviewStore({ storage: () => memoryStorage() })
    expect(store.getState()).toMatchObject({ entries: {}, playBestGuesses: false })
  })

  it('records best guesses by track, and drops them when approved or gone', () => {
    const store = createQueueReviewStore({ storage: () => memoryStorage() })
    const a = spotifyTrack('A')
    const b = spotifyTrack('B')
    store.getState().report(a, testCandidate('a1'))
    store.getState().report(b, testCandidate('b1'))
    store.getState().report(a, testCandidate('a2'))
    expect(store.getState().entries).toEqual({
      [a.id]: testCandidate('a2'),
      [b.id]: testCandidate('b1'),
    })

    store.getState().dismiss(a.id)
    expect(Object.keys(store.getState().entries)).toEqual([b.id])

    store.getState().keepOnly(new Set([a.id]))
    expect(store.getState().entries).toEqual({})
  })

  it('keeps the same entries object when nothing is dropped', () => {
    const store = createQueueReviewStore({ storage: () => memoryStorage() })
    const a = spotifyTrack('A')
    store.getState().report(a, testCandidate('a1'))
    const { entries } = store.getState()
    store.getState().keepOnly(new Set([a.id]))
    store.getState().dismiss('spotify:track:other')
    expect(store.getState().entries).toBe(entries)
    store.getState().clear()
    expect(store.getState().entries).toEqual({})
  })

  it('saves the list and the setting, and reads them back', () => {
    const storage = memoryStorage()
    const first = createQueueReviewStore({ storage: () => storage })
    const track = spotifyTrack('A')
    first.getState().report(track, testCandidate('a1'))
    first.getState().setPlayBestGuesses(true)

    const second = createQueueReviewStore({ storage: () => storage })
    expect(second.getState()).toMatchObject({
      entries: { [track.id]: testCandidate('a1') },
      playBestGuesses: true,
    })
  })

  it('keeps only what is valid from stored data', () => {
    const track = testTrack('Song')
    const storage = memoryStorage({
      [REVIEW_STORAGE_KEY]: JSON.stringify({
        state: {
          entries: {
            [track.id]: testCandidate('ok'),
            'not an id': testCandidate('x'),
            'spotify:track:bad': { source: 'ytm' },
          },
          playBestGuesses: 'yes',
        },
        version: 1,
      }),
    })
    const store = createQueueReviewStore({ storage: () => storage })
    expect(store.getState()).toMatchObject({
      entries: { [track.id]: testCandidate('ok') },
      playBestGuesses: false,
    })
  })

  it('survives storage that throws', () => {
    const store = createQueueReviewStore({
      storage: () => {
        throw new Error('blocked')
      },
    })
    store.getState().setPlayBestGuesses(true)
    expect(store.getState().playBestGuesses).toBe(true)
  })
})

describe('cleanCandidate', () => {
  it('copies a valid candidate, signals included, and nothing unknown', () => {
    const candidate = testCandidate('x', {
      signals: {
        isrcVerified: true,
        sourceAlbumMatch: false,
        releaseId: 'MPREb_1',
        releaseYear: 2009,
        label: 'XL',
      },
    })
    expect(cleanCandidate({ ...candidate, extra: 'dropped' })).toEqual(candidate)
  })

  it('drops malformed optional fields on their own', () => {
    const { durationMs: _duration, ...withoutDuration } = testCandidate('x')
    expect(
      cleanCandidate({
        ...testCandidate('x'),
        durationMs: -5,
        signals: { isrcVerified: 'yes', sourceAlbumMatch: false },
      }),
    ).toEqual(withoutDuration)
    expect(
      cleanCandidate({
        ...testCandidate('x'),
        signals: { isrcVerified: true, sourceAlbumMatch: false, releaseYear: 1.5, releaseId: '' },
      })?.signals,
    ).toEqual({ isrcVerified: true, sourceAlbumMatch: false })
  })

  it.each([
    ['not an object', 'x'],
    ['an unknown source', { ...testCandidate('x'), source: 'napster' }],
    ['an empty ref', { ...testCandidate('x'), ref: '' }],
    ['an unknown kind', { ...testCandidate('x'), kind: 'podcast' }],
    ['a confidence above 1', { ...testCandidate('x'), confidence: 1.2 }],
    ['artists that are not strings', { ...testCandidate('x'), artists: [1] }],
    ['no evidence', { ...testCandidate('x'), evidence: undefined }],
  ])('rejects %s', (_case, value) => {
    expect(cleanCandidate(value)).toBeUndefined()
  })

  it('sanitizes anything into a valid review', () => {
    expect(sanitizeReview(null)).toEqual({ entries: {}, playBestGuesses: false })
    expect(sanitizeReview({ entries: [], playBestGuesses: true })).toEqual({
      entries: {},
      playBestGuesses: true,
    })
  })
})
