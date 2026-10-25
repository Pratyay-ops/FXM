import { describe, expect, it } from 'vitest'
import { group, item, label, source } from './testing'
import { casesOf, EvalFixtureError, parseEvalGroup } from './types'

const valid = group({
  id: 'sp:0VjIjW4GlUZAMYd2vXMi3b',
  variants: [
    {
      slice: 'spotify',
      source: source('Song', 'Artist', 200, { isrc: 'X', isrcOrigin: 'catalog' }),
    },
    { slice: 'data-export', source: source('Song', 'Artist', undefined) },
  ],
  items: { a: item('Song', 'Artist', 200, { album: 'LP', albumId: 'MPREb_x', explicit: true }) },
  pages: {
    'songs/Artist Song': { items: ['a'] },
    'isrc-top-card/X': { item: null },
    'description/a': { facts: { label: 'L' }, excerpt: 'Provided to YouTube by L' },
    'songs/broken': { error: 'Network' },
  },
  labels: { a: label('exact', { ambiguous: true, by: 'owner', reviewed: '2026-10-30' }) },
})

function broken(change: (value: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>
  change(copy)
  return copy
}

describe('parseEvalGroup', () => {
  it('accepts a well-formed group as it is', () => {
    expect(parseEvalGroup(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it.each([
    ['id', (g: Record<string, unknown>) => Object.assign(g, { id: 'spotify:x' })],
    ['split', (g: Record<string, unknown>) => Object.assign(g, { split: 'test' })],
    ['categories', (g: Record<string, unknown>) => Object.assign(g, { categories: ['pop'] })],
    ['provenance', (g: Record<string, unknown>) => Object.assign(g, { provenance: [] })],
    ['variants', (g: Record<string, unknown>) => Object.assign(g, { variants: [] })],
    [
      'variants[1].slice (twice)',
      (g: Record<string, unknown>) =>
        Object.assign(g, { variants: [valid.variants[0], valid.variants[0]] }),
    ],
    [
      'variants[0].source.durationMs',
      (g: Record<string, unknown>) =>
        Object.assign(g, {
          variants: [{ slice: 'spotify', source: { ...source('S', 'A', 1), durationMs: -1 } }],
        }),
    ],
    [
      'variants[0].source.isrcOrigin',
      (g: Record<string, unknown>) =>
        Object.assign(g, {
          variants: [{ slice: 'spotify', source: { ...source('S', 'A', 1), isrcOrigin: 'guess' } }],
        }),
    ],
    [
      'recording.pages.songs/Artist Song.items: b',
      (g: Record<string, unknown>) => {
        const recording = g.recording as { pages: Record<string, unknown> }
        recording.pages['songs/Artist Song'] = { items: ['a', 'b'] }
      },
    ],
    [
      'recording.items.a.explicit',
      (g: Record<string, unknown>) => {
        const recording = g.recording as { items: Record<string, unknown> }
        recording.items.a = { ...item('S', 'A', 1), explicit: false }
      },
    ],
    [
      'labels.a.label',
      (g: Record<string, unknown>) =>
        Object.assign(g, { labels: { a: { ...label('exact'), label: 'right' } } }),
    ],
  ])('names a malformed %s', (path, change) => {
    expect(() => parseEvalGroup(broken(change))).toThrow(EvalFixtureError)
    expect(() => parseEvalGroup(broken(change))).toThrow(path)
  })

  it('refuses anything but an object', () => {
    expect(() => parseEvalGroup([])).toThrow(EvalFixtureError)
    expect(() => parseEvalGroup(null)).toThrow(EvalFixtureError)
  })
})

describe('casesOf', () => {
  it('makes one case per input', () => {
    expect(casesOf([valid]).map((evalCase) => evalCase.id)).toEqual([
      'sp:0VjIjW4GlUZAMYd2vXMi3b/spotify',
      'sp:0VjIjW4GlUZAMYd2vXMi3b/data-export',
    ])
  })
})
