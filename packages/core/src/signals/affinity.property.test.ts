/**
 * Property-style tests of the affinity: random histories of signals, applied in order, in a
 * random order and in separate batches merged afterwards, must all give the affinity of the
 * formula `Σ w · 2^(−(now − t) / halfLife)`, computed here from scratch.
 */

import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { Track } from '../model'
import { createSeededRandom, fisherYatesShuffle, type RandomSource } from '../queue/random'
import {
  AFFINITY_HALF_LIFE_MS,
  type AffinityEntry,
  AffinityIndex,
  type AffinityKind,
  affinityAt,
  affinityRank,
  signalContributions,
} from './affinity'
import type { ListeningSignal } from './signals'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 0, 1)
const SPAN = 180 * DAY
const ARTISTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
const TAGS = ['rock', 'jazz', 'Hip-Hop', 'hip hop', 'ambient']

function pick<T>(random: RandomSource, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T
}

/** A pool of tracks, each by one or two of a few artists, with some tags. */
function trackPool(random: RandomSource): Track[] {
  return Array.from({ length: 12 }, (_, n) => ({
    id: formatId(n % 3 === 0 ? 'yt' : 'ytm', 'track', `v${n % 10}`),
    source: n % 3 === 0 ? 'yt' : 'ytm',
    title: `Song ${n}`,
    artists: [
      { name: pick(random, ARTISTS) },
      ...(random() < 0.4 ? [{ name: pick(random, ARTISTS) }] : []),
    ],
    artwork: [],
    kind: 'song',
    durationMs: 120_000 + Math.floor(random() * 240_000),
    tags: random() < 0.7 ? [pick(random, TAGS), pick(random, TAGS)] : [],
  }))
}

/** A random history: plays, skips, likes and unlikes, adds and removals, over six months. */
function history(seed: number, count: number): ListeningSignal[] {
  const random = createSeededRandom(seed)
  const pool = trackPool(random)
  const playlistId = formatId('local', 'playlist', 'p')
  const signals: ListeningSignal[] = []
  for (let n = 0; n < count; n++) {
    const track = pick(random, pool)
    const at = T0 + Math.floor(random() * SPAN)
    const roll = random()
    if (roll < 0.6) {
      const durationMs = track.durationMs ?? 200_000
      const completed = random() < 0.5
      signals.push({
        type: 'play',
        at,
        track,
        playedMs: completed ? durationMs : Math.floor(random() * durationMs),
        durationMs,
        completed,
        skipped: !completed && random() < 0.6,
      })
    } else if (roll < 0.75) {
      signals.push({ type: 'like', at, track })
    } else if (roll < 0.85) {
      signals.push({ type: 'unlike', at: at + DAY, likedAt: at, track })
    } else if (roll < 0.95) {
      signals.push({ type: 'playlist-add', at, track, playlistId })
    } else {
      signals.push({ type: 'playlist-remove', at: at + DAY, addedAt: at, track, playlistId })
    }
  }
  return signals
}

/** The affinity of every entry at `now`, computed from scratch with the formula. */
function reference(signals: readonly ListeningSignal[], now: number) {
  const totals = new Map<string, { score: number; skips: number; plays: number }>()
  for (const signal of signals) {
    for (const part of signalContributions(signal)) {
      const id = `${part.kind}|${part.key}`
      const total = totals.get(id) ?? { score: 0, skips: 0, plays: 0 }
      const fade = 2 ** (-(now - part.at) / AFFINITY_HALF_LIFE_MS)
      total.score += part.score * fade
      total.skips += part.skips * fade
      total.plays += part.plays
      totals.set(id, total)
    }
  }
  return totals
}

function scoresAt(entries: readonly AffinityEntry[], now: number) {
  return new Map(
    entries.map((entry) => {
      const { score, skips } = affinityAt(entry, now)
      return [`${entry.kind}|${entry.key}`, { score, skips, plays: entry.plays }]
    }),
  )
}

function expectSameScores(
  actual: Map<string, { score: number; skips: number; plays: number }>,
  expected: Map<string, { score: number; skips: number; plays: number }>,
) {
  for (const [id, want] of expected) {
    const got = actual.get(id) ?? { score: 0, skips: 0, plays: 0 }
    expect(got.score, id).toBeCloseTo(want.score, 9)
    expect(got.skips, id).toBeCloseTo(want.skips, 9)
    expect(got.plays, id).toBe(want.plays)
  }
  for (const id of actual.keys()) expect(expected.has(id), id).toBe(true)
}

describe('affinity properties', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'gives the formula’s affinity whatever the order or batching (seed %i)',
    (seed) => {
      const signals = history(seed, 400)
      const now = T0 + SPAN + 10 * DAY
      const expected = reference(signals, now)

      const inOrder = new AffinityIndex({ now: () => now })
      inOrder.add([...signals].sort((a, b) => a.at - b.at))

      const shuffled = new AffinityIndex({ now: () => now })
      shuffled.add(fisherYatesShuffle(signals, createSeededRandom(seed + 100)))

      // Four devices' worth of batches, merged afterwards in reverse.
      const batches = Array.from({ length: 4 }, () => new AffinityIndex({ now: () => now }))
      signals.forEach((signal, n) => {
        batches[n % 4]?.add(signal)
      })
      const merged = new AffinityIndex({ now: () => now })
      for (const batch of [...batches].reverse()) merged.merge(batch.entries())

      for (const affinity of [inOrder, shuffled, merged]) {
        expectSameScores(scoresAt(affinity.entries(), now), expected)
      }
    },
  )

  it.each([11, 12, 13])(
    'ranks entries as their affinity orders them at any time (seed %i)',
    (seed) => {
      const affinity = new AffinityIndex()
      affinity.add(history(seed, 300))
      for (const kind of ['track', 'artist', 'tag'] as AffinityKind[]) {
        const entries = affinity.entries(kind).filter((entry) => entry.score > 0)
        const byRank = [...entries].sort((a, b) => affinityRank(b) - affinityRank(a))
        for (const now of [T0 + SPAN, T0 + SPAN + 60 * DAY, T0 + 4 * SPAN]) {
          const scores = byRank.map((entry) => affinityAt(entry, now).score)
          for (let n = 1; n < scores.length; n++) {
            expect(scores[n - 1] as number).toBeGreaterThanOrEqual(
              (scores[n] as number) * (1 - 1e-9),
            )
          }
        }
      }
    },
  )

  it('cancels every like and add that is taken back, leaving only the plays', () => {
    const random = createSeededRandom(21)
    const pool = trackPool(random)
    const playlistId = formatId('local', 'playlist', 'p')
    const plays: ListeningSignal[] = pool.map((track, n) => ({
      type: 'play',
      at: T0 + n * DAY,
      track,
      playedMs: 60_000,
      durationMs: track.durationMs ?? 200_000,
      completed: false,
      skipped: true,
    }))
    const takenBack: ListeningSignal[] = pool.flatMap((track, n) => [
      { type: 'like', at: T0 + n * 3 * DAY, track },
      { type: 'playlist-add', at: T0 + n * 5 * DAY, track, playlistId },
      { type: 'unlike', at: T0 + 400 * DAY, likedAt: T0 + n * 3 * DAY, track },
      { type: 'playlist-remove', at: T0 + 401 * DAY, addedAt: T0 + n * 5 * DAY, track, playlistId },
    ])
    const now = T0 + 402 * DAY
    const onlyPlays = new AffinityIndex({ now: () => now })
    onlyPlays.add(plays)
    const both = new AffinityIndex({ now: () => now })
    both.add(fisherYatesShuffle([...plays, ...takenBack], random))
    expectSameScores(scoresAt(both.entries(), now), scoresAt(onlyPlays.entries(), now))
  })
})
