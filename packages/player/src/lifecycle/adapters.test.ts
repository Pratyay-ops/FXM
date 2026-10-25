import { type AudioSource, DEFAULT_QUALITY_PREFS, formatId, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testStream } from '../testing/fixtures'
import {
  createMemoryMatchStore,
  fromAudioSource,
  type MatchKey,
  matchKeyString,
  type StoredMatch,
  sanitizeStoredMatch,
} from './adapters'
import { testCandidate, testContext } from './testing/fixtures'

const match: StoredMatch = {
  band: 'auto',
  candidate: testCandidate('x'),
  alternatives: [testCandidate('y')],
  evidence: ['title 0.97'],
  userPinned: false,
  decidedAt: 1,
}

describe('fromAudioSource', () => {
  it('passes the request to a plain audio source, the signal inside the context', async () => {
    const seen: { ctx?: ProviderContext } = {}
    const source: AudioSource = {
      id: 'archive',
      match: async () => [],
      resolve: async (_candidate, ctx) => {
        seen.ctx = ctx
        return [testStream('a')]
      },
    }
    const adapted = fromAudioSource(source)
    const signal = new AbortController().signal
    expect(adapted.id).toBe('archive')
    expect(adapted.hasFallback).toBeUndefined()
    const options = await adapted.resolve(testCandidate('a', { source: 'archive' }), {
      ctx: testContext(),
      prefs: DEFAULT_QUALITY_PREFS,
      rung: 'top',
      priority: 'current-track',
      signal,
    })
    expect(options).toEqual([testStream('a')])
    expect(seen.ctx?.signal).toBe(signal)
  })
})

describe('the memory match store', () => {
  it('files decisions by track, mode and target, as the match cache keys them', async () => {
    const store = createMemoryMatchStore()
    const trackId = formatId('ytm', 'track', 'v')
    const key: MatchKey = { sourceTrackId: trackId, mode: 'music', target: 'song' }
    await store.put(key, match)
    expect(await store.get({ ...key, sourceTrackId: formatId('yt', 'track', 'v') })).toBe(match)
    expect(await store.get({ ...key, mode: 'all' })).toBeUndefined()
    expect(await store.get({ ...key, target: 'lossless' })).toBeUndefined()
    expect(store.size).toBe(1)
    await store.delete(key)
    expect(store.size).toBe(0)
    // The song decision under 2.6's `<entityKey>|<mode>`; the lossless one beside it.
    expect(matchKeyString(key)).toBe('youtube:track:v|music')
    expect(matchKeyString({ ...key, target: 'lossless' })).toBe('youtube:track:v|music|lossless')
  })
})

describe('sanitizeStoredMatch', () => {
  it('keeps a well-formed decision, a pin and a decision that nothing came close', () => {
    expect(sanitizeStoredMatch(match)).toEqual(match)
    const pin = { ...match, band: 'none', userPinned: true, signals: undefined }
    expect(sanitizeStoredMatch(pin)).toEqual({ ...match, band: 'none', userPinned: true })
    const miss = { band: 'none', alternatives: [], evidence: [], userPinned: false, decidedAt: 5 }
    expect(sanitizeStoredMatch(miss)).toEqual(miss)
    expect(sanitizeStoredMatch({ ...miss, candidate: null })).toEqual(miss)
    const signals = { isrcVerified: true, sourceAlbumMatch: false }
    expect(sanitizeStoredMatch({ ...match, signals })).toEqual({ ...match, signals })
  })

  it('drops malformed alternatives, evidence and signals, and unknown fields', () => {
    const odd = {
      ...match,
      alternatives: [null, 42, {}, { source: 'ytm', ref: 'z' }, testCandidate('y')],
      evidence: ['ok', 7],
      signals: { isrcVerified: 'yes' },
      extra: true,
    }
    expect(sanitizeStoredMatch(odd)).toEqual({ ...match, evidence: ['ok'] })
    const bare = { band: 'auto', candidate: testCandidate('x'), userPinned: false, decidedAt: 1 }
    expect(sanitizeStoredMatch(bare)).toEqual({ ...bare, alternatives: [], evidence: [] })
  })

  it.each([
    ['nothing', undefined],
    ['a string', 'match'],
    ['an unknown band', { ...match, band: 'great' }],
    ['an Auto decision without a candidate', { ...match, candidate: undefined }],
    ['a pin without a candidate', { ...match, band: 'none', candidate: null, userPinned: true }],
    [
      'a candidate of an unknown source',
      { ...match, candidate: { ...testCandidate('x'), source: 'x' } },
    ],
    ['a candidate without a ref', { ...match, candidate: testCandidate('') }],
    ['a candidate of an unknown kind', { ...match, candidate: { ...testCandidate('x'), kind: 1 } }],
    ['a candidate without its title', { ...match, candidate: { source: 'ytm', ref: 'x' } }],
    ['a pin flag that is not a boolean', { ...match, userPinned: 'yes' }],
    ['a time that is not a number', { ...match, decidedAt: Number.NaN }],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeStoredMatch(value)).toBeUndefined()
  })
})
