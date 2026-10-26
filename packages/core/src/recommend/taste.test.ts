import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { AffinityEntry } from '../signals/affinity'
import {
  indexTaste,
  MIN_TASTE_ARTISTS,
  mostlySkipped,
  PICK_WEIGHT,
  pickContributions,
} from './taste'
import { DAY, HOUR, like, NOW, play, profileOf, ytm } from './test-fixtures'

const copper = ytm('v1', 'Copper Sun', 'Aurora Lane')
const static_ = ytm('v2', 'Static Bloom', 'Basalt')
const harbor = ytm('v3', 'Harbor Lights', 'Cinder & Co')

describe('indexTaste', () => {
  it('normalizes affinity on a log scale against the strongest of its kind', () => {
    const taste = indexTaste(
      profileOf([
        play(copper, 2 * HOUR),
        play(copper, 3 * HOUR),
        play(copper, 4 * HOUR),
        play(static_, 5 * HOUR),
      ]),
      NOW,
    )
    const top = taste.artist('aurora lane')
    const other = taste.artist('basalt')
    expect(top?.norm).toBe(1)
    expect(other?.norm).toBeGreaterThan(1 / 3)
    expect(other?.norm).toBeLessThan(1)
    expect(taste.artists.map((artist) => artist.key)).toEqual(['aurora lane', 'basalt'])
    expect(taste.track(['youtube:track:v1'])?.norm).toBe(1)
  })

  it('decays affinity to its own time', () => {
    const now = indexTaste(profileOf([play(copper, 0)]), NOW)
    const later = indexTaste(profileOf([play(copper, 0)]), NOW + 14 * DAY)
    expect(later.track(['youtube:track:v1'])?.score).toBeCloseTo(
      (now.track(['youtube:track:v1'])?.score ?? 0) / 2,
    )
  })

  it('counts skips apart, as a share of what the user did', () => {
    const taste = indexTaste(
      profileOf([
        play(copper, HOUR, { completed: false, skipped: true, playedMs: 10_000 }),
        play(copper, 2 * HOUR, { completed: false, skipped: true, playedMs: 10_000 }),
      ]),
      NOW,
    )
    const track = taste.track(['youtube:track:v1'])
    expect(track?.skipShare).toBeGreaterThan(0.6)
    expect(taste.artist('aurora lane')?.skipShare).toBeGreaterThan(0.6)
  })

  it('knows what was played, when, and how many plays ago', () => {
    const taste = indexTaste(
      profileOf([play(copper, 3 * HOUR), play(static_, 2 * HOUR), play(copper, HOUR)]),
      NOW,
    )
    expect(taste.known(['youtube:track:v1'])).toBe(true)
    expect(taste.known(['song:aurora lane|copper sun'])).toBe(true)
    expect(taste.known(['youtube:track:v9'])).toBe(false)
    expect(taste.lastPlayedAt(['youtube:track:v1'])).toBe(NOW - HOUR)
    expect(taste.playsAgo(['song:aurora lane|copper sun'])).toBe(0)
    expect(taste.playsAgo(['youtube:track:v2'])).toBe(1)
    expect(taste.playsAgo(['youtube:track:v9'])).toBeUndefined()
    expect(taste.recent.map((one) => one.playedAt)).toEqual([
      NOW - HOUR,
      NOW - 2 * HOUR,
      NOW - 3 * HOUR,
    ])
  })

  it('counts a liked track as known even if it never played', () => {
    const taste = indexTaste(profileOf([like(harbor, DAY)]), NOW)
    expect(taste.known(['youtube:track:v3'])).toBe(true)
    expect(taste.lastPlayedAt(['youtube:track:v3'])).toBeUndefined()
  })

  it('is a cold start with fewer than three artists', () => {
    expect(MIN_TASTE_ARTISTS).toBe(3)
    expect(indexTaste({}, NOW).coldStart).toBe(true)
    expect(indexTaste(profileOf([play(copper, HOUR), play(static_, HOUR)]), NOW).coldStart).toBe(
      true,
    )
    expect(
      indexTaste(profileOf([play(copper, HOUR), play(static_, HOUR), play(harbor, HOUR)]), NOW)
        .coldStart,
    ).toBe(false)
  })

  it('counts onboarding picks as liked artists and genres', () => {
    const taste = indexTaste(
      {
        picks: {
          artists: [
            { name: 'Aurora Lane' },
            { name: 'Basalt', id: formatId('ytm', 'artist', 'UCb') },
            { name: 'Cinder & Co' },
          ],
          genres: ['Hip-Hop', 'lo-fi'],
          at: NOW - DAY,
        },
      },
      NOW,
    )
    expect(taste.coldStart).toBe(false)
    expect(taste.artist('basalt')?.ids).toEqual(['ytm:artist:UCb'])
    expect(taste.artist('basalt')?.plays).toBe(0)
    expect(taste.tag('hip hop')).toBe(1)
    expect(taste.tag('jazz')).toBe(0)
  })

  it('counts a picked artist as one the user knows, played or not', () => {
    const taste = indexTaste(
      profileOf([play(copper, HOUR)], {
        picks: { artists: [{ name: 'Basalt' }, { name: 'Aurora Lane' }], genres: [], at: NOW },
      }),
      NOW,
    )
    expect(taste.artist('basalt')).toMatchObject({ picked: true, familiarity: 1, plays: 0 })
    expect(taste.artist('aurora lane')).toMatchObject({ picked: true, familiarity: 1, plays: 1 })
    const unpicked = indexTaste(profileOf([play(copper, HOUR)]), NOW).artist('aurora lane')
    expect(unpicked?.picked).toBe(false)
    expect(unpicked?.familiarity).toBeCloseTo(0.4)
  })

  it('merges artist entries that only a channel suffix kept apart', () => {
    const entry = (key: string, label: string, score: number): AffinityEntry => ({
      kind: 'artist',
      key,
      label,
      ids: [],
      at: NOW,
      score,
      skips: 0,
      plays: 1,
    })
    const taste = indexTaste(
      {
        artists: [
          entry('aurora lane', 'Aurora Lane', 2),
          entry('aurora lanevevo', 'Aurora LaneVEVO', 1),
        ],
      },
      NOW,
    )
    expect(taste.artists).toHaveLength(1)
    expect(taste.artist('aurora lane')?.score).toBe(3)
    expect(taste.artist('aurora lane')?.plays).toBe(2)
  })

  it('leaves out malformed entries and plays', () => {
    const taste = indexTaste(
      {
        tracks: [{ entry: { kind: 'track', key: 'x', at: Number.NaN } as never }, null as never],
        artists: [{ kind: 'tag', key: 'x' } as never, 'nope' as never],
        recent: [
          { trackId: 'nope' as never, playedAt: NOW },
          { trackId: copper.id, playedAt: Number.NaN },
        ],
      },
      NOW,
    )
    expect(taste.tracks).toEqual([])
    expect(taste.artists).toEqual([])
    expect(taste.recent).toEqual([])
  })
})

describe('pickContributions', () => {
  it('gives each picked artist and genre the weight of a like, once', () => {
    const entries = pickContributions({
      artists: [{ name: 'Basalt' }, { name: 'BASALT' }, { name: 'Various Artists' }],
      genres: ['Hip-Hop', 'hip hop', ''],
      at: NOW,
    })
    expect(entries.map((entry) => [entry.kind, entry.key, entry.score])).toEqual([
      ['artist', 'basalt', PICK_WEIGHT],
      ['tag', 'hip hop', PICK_WEIGHT],
    ])
  })

  it('gives nothing without picks or with a bad time', () => {
    expect(pickContributions(undefined)).toEqual([])
    expect(pickContributions({ artists: [{ name: 'Basalt' }], genres: [], at: -1 })).toEqual([])
  })
})

describe('mostlySkipped', () => {
  it('takes a whole skip, and twice as much skipping as listening', () => {
    expect(mostlySkipped(undefined)).toBe(false)
    // One early skip is not yet a whole one.
    expect(mostlySkipped({ score: 0.05, skips: 0.95 })).toBe(false)
    expect(mostlySkipped({ score: 0.1, skips: 1.9 })).toBe(true)
    expect(mostlySkipped({ score: 1, skips: 2 })).toBe(false)
    expect(mostlySkipped({ score: 1, skips: 2.1 })).toBe(true)
    // More taken back than given counts as no listening.
    expect(mostlySkipped({ score: -1, skips: 1 })).toBe(true)
  })
})
