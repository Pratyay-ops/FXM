import { describe, expect, it } from 'vitest'
import {
  NO_STABLE_SHELVES,
  type StableShelves,
  sanitizeStableShelves,
  sanitizeTrack,
} from './stable'
import { ytm } from './test-fixtures'

const track = ytm('v1', 'Copper Sun', 'Aurora Lane', {
  album: { name: 'Lanes' },
  isrc: 'GB-ARL-93-00135',
  tags: ['Dream Pop'],
  popularity: 40,
  trackNumber: 2,
  externalIds: { spotify: 'abc' },
})

describe('sanitizeTrack', () => {
  it('keeps a well-formed track', () => {
    expect(sanitizeTrack(JSON.parse(JSON.stringify(track)))).toEqual({
      ...track,
      isrc: 'GBARL9300135',
    })
  })

  it('refuses what is not a track, and drops malformed optional fields', () => {
    expect(sanitizeTrack(null)).toBeUndefined()
    expect(sanitizeTrack({ ...track, id: 'nope' })).toBeUndefined()
    expect(sanitizeTrack({ ...track, title: '' })).toBeUndefined()
    expect(sanitizeTrack({ ...track, kind: 'podcast' })).toBeUndefined()
    const odd = sanitizeTrack({
      ...track,
      source: 'spotify',
      artists: [{ name: 'Aurora Lane', id: 'bad' }, { name: '' }, 'x'],
      artwork: [{ url: 'javascript:alert(1)' }, { url: 'https://example.test/a.jpg', width: -1 }],
      durationMs: -5,
      popularity: 400,
      trackNumber: 1.5,
      tags: 'rock',
      externalIds: { nowhere: 'x' },
    })
    expect(odd).toEqual({
      id: track.id,
      source: 'ytm',
      title: 'Copper Sun',
      artists: [{ name: 'Aurora Lane' }],
      artwork: [{ url: 'https://example.test/a.jpg' }],
      kind: 'song',
      album: { name: 'Lanes' },
      isrc: 'GBARL9300135',
    })
  })
})

describe('sanitizeStableShelves', () => {
  const stable: StableShelves = {
    entries: [
      {
        kind: 'discover',
        mode: 'music',
        period: '2026-W44',
        items: [{ track, score: 1.5, familiar: false }],
      },
      {
        kind: 'mixes',
        mode: 'all',
        period: '2026-10-26',
        mixes: [
          {
            id: 'daily-mix-1',
            title: 'Daily Mix 1',
            artists: ['Aurora Lane'],
            tracks: [{ track, score: 1, familiar: true }],
          },
        ],
      },
    ],
  }

  it('keeps well-formed entries, as stored', () => {
    expect(sanitizeStableShelves(JSON.parse(JSON.stringify(stable)))).toEqual(
      JSON.parse(
        JSON.stringify({
          entries: [
            {
              ...stable.entries[0],
              items: [{ track: { ...track, isrc: 'GBARL9300135' }, score: 1.5, familiar: false }],
            },
            {
              ...stable.entries[1],
              mixes: [
                {
                  id: 'daily-mix-1',
                  title: 'Daily Mix 1',
                  artists: ['Aurora Lane'],
                  tracks: [{ track: { ...track, isrc: 'GBARL9300135' }, score: 1, familiar: true }],
                },
              ],
            },
          ],
        }),
      ),
    )
  })

  it('reads anything else as nothing kept', () => {
    for (const value of [null, 'x', [], { entries: 'x' }, { entries: [{ kind: 'discover' }] }]) {
      expect(sanitizeStableShelves(value)).toEqual(NO_STABLE_SHELVES)
    }
  })

  it('drops bad tracks, empty lists, unknown kinds and repeats of a kind and mode', () => {
    const value = {
      entries: [
        { kind: 'discover', mode: 'music', period: '2026-W44', items: [{ track: { id: 'x' } }] },
        { kind: 'discover', mode: 'music', period: '2026-W44', items: [{ track, score: 'high' }] },
        { kind: 'discover', mode: 'music', period: '2026-W43', items: [{ track }] },
        { kind: 'mixes', mode: 'music', period: '2026-10-26', mixes: [{ id: 'm', title: '' }] },
        { kind: 'radio', mode: 'music', period: '2026-10-26' },
        { kind: 'discover', mode: 'video', period: '2026-W44', items: [{ track }] },
      ],
    }
    const { entries } = sanitizeStableShelves(value)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'discover', mode: 'music', period: '2026-W44' })
    expect(entries[0]?.kind === 'discover' && entries[0].items[0]?.score).toBe(0)
  })
})
