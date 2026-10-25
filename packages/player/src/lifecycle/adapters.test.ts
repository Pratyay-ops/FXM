import { type AudioSource, DEFAULT_QUALITY_PREFS, formatId, type ProviderContext } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testStream } from '../testing/fixtures'
import {
  createMemoryMatchStore,
  fromAudioSource,
  isStoredMatch,
  type MatchKey,
  matchKeyString,
  type StoredMatch,
} from './adapters'
import { testCandidate, testContext } from './testing/fixtures'

const match: StoredMatch = {
  band: 'auto',
  candidate: testCandidate('x'),
  alternatives: [],
  pinned: false,
  matchedAt: 1,
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
      priority: 'playback',
      signal,
    })
    expect(options).toEqual([testStream('a')])
    expect(seen.ctx?.signal).toBe(signal)
  })
})

describe('the memory match store', () => {
  it('files matches by track, mode and target, one key for both YouTube prefixes', async () => {
    const store = createMemoryMatchStore()
    const key: MatchKey = { trackId: formatId('ytm', 'track', 'v'), mode: 'music', target: 'song' }
    await store.put(key, match)
    expect(await store.get({ ...key, trackId: formatId('yt', 'track', 'v') })).toBe(match)
    expect(await store.get({ ...key, mode: 'all' })).toBeUndefined()
    expect(await store.get({ ...key, target: 'lossless' })).toBeUndefined()
    expect(store.size).toBe(1)
    await store.delete(key)
    expect(store.size).toBe(0)
    expect(matchKeyString(key)).toBe('youtube:track:v\u0000music\u0000song')
  })
})

describe('isStoredMatch', () => {
  it('accepts a well-formed match', () => {
    expect(isStoredMatch(match)).toBe(true)
    expect(isStoredMatch({ ...match, band: 'suggest', pinned: true })).toBe(true)
  })

  it.each([
    ['nothing', undefined],
    ['a string', 'match'],
    ['a None band', { ...match, band: 'none' }],
    ['no candidate', { ...match, candidate: null }],
    [
      'a candidate of an unknown source',
      { ...match, candidate: { ...match.candidate, source: 'x' } },
    ],
    ['a candidate without a ref', { ...match, candidate: { ...match.candidate, ref: '' } }],
    ['a candidate without a kind', { ...match, candidate: { ...match.candidate, kind: 1 } }],
    ['no alternatives', { ...match, alternatives: undefined }],
    ['a pin flag that is not a boolean', { ...match, pinned: 'yes' }],
    ['a time that is not a number', { ...match, matchedAt: Number.NaN }],
  ])('rejects %s', (_label, value) => {
    expect(isStoredMatch(value)).toBe(false)
  })
})
