import { describe, expect, it } from 'vitest'
import { type EntityId, formatId } from '../ids'
import type { Track } from '../model'
import {
  AFFINITY_HALF_LIFE_MS,
  type AffinityEntry,
  AffinityIndex,
  type AffinityScore,
  affinityAt,
  affinityContributions,
  affinityCredits,
  affinityEntryId,
  affinityKey,
  affinityRank,
  affinityScoreAt,
  compareAffinityScores,
  DEFAULT_AFFINITY_WEIGHTS,
  decayFactor,
  isEmptyAffinity,
  MAX_AFFINITY_IDS,
  mergeAffinity,
  reattributeAffinity,
} from './affinity'
import type { ListeningSignal, PlaySignal } from './signals'

const DAY = 24 * 60 * 60 * 1000
const HALF_LIFE = AFFINITY_HALF_LIFE_MS
const T0 = Date.UTC(2026, 9, 1)

function song(n: number, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', `video${n}`),
    source: 'ytm',
    title: `Song ${n}`,
    artists: [{ id: formatId('ytm', 'artist', `UC${n}`), name: `Artist ${n}` }],
    artwork: [],
    kind: 'song',
    durationMs: 200_000,
    ...overrides,
  }
}

function play(track: Track, overrides: Partial<PlaySignal> = {}): PlaySignal {
  return {
    type: 'play',
    at: T0,
    track,
    playedMs: 200_000,
    durationMs: 200_000,
    completed: true,
    skipped: false,
    ...overrides,
  }
}

/** The contributions of `signal`, as `kind:key` → score and skips. */
function effects(signal: ListeningSignal) {
  return Object.fromEntries(
    affinityContributions(signal).map((entry) => [
      `${entry.kind}:${entry.key}`,
      { score: entry.score, skips: entry.skips },
    ]),
  )
}

function entry(overrides: Partial<AffinityEntry> = {}): AffinityEntry {
  return {
    kind: 'artist',
    key: 'band',
    label: 'Band',
    ids: [],
    at: T0,
    score: 1,
    skips: 0,
    plays: 1,
    ...overrides,
  }
}

describe('decayFactor', () => {
  it('halves every half-life', () => {
    expect(AFFINITY_HALF_LIFE_MS).toBe(14 * DAY)
    expect(decayFactor(0)).toBe(1)
    expect(decayFactor(14 * DAY)).toBeCloseTo(0.5, 12)
    expect(decayFactor(28 * DAY)).toBeCloseTo(0.25, 12)
    expect(decayFactor(7 * DAY)).toBeCloseTo(Math.SQRT1_2, 12)
    expect(decayFactor(1000, 1000)).toBeCloseTo(0.5, 12)
  })

  it('never grows anything: a time ahead or not a number counts as no time', () => {
    expect(decayFactor(-DAY)).toBe(1)
    expect(decayFactor(Number.NaN)).toBe(1)
  })

  it('fades to nothing, without errors, after a very long time', () => {
    expect(decayFactor(100 * 365 * DAY)).toBe(0)
  })

  it('refuses a half-life that is not a positive number', () => {
    for (const halfLife of [0, -DAY, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decayFactor(DAY, halfLife)).toThrow(RangeError)
      expect(() => affinityRank(entry(), halfLife)).toThrow(RangeError)
      expect(() => mergeAffinity(entry(), entry(), halfLife)).toThrow(RangeError)
    }
  })
})

describe('affinityContributions', () => {
  it('scores a play to the end for the track, each artist and each tag', () => {
    const track = song(1, {
      artists: [{ id: formatId('ytm', 'artist', 'UC1'), name: 'Main' }, { name: 'Guest' }],
      tags: ['Rock', 'Indie'],
    })
    const entries = affinityContributions(play(track))
    expect(entries).toEqual([
      {
        kind: 'track',
        key: 'youtube:track:video1',
        label: 'Song 1',
        ids: [track.id],
        at: T0,
        score: 1,
        skips: 0,
        plays: 1,
        lastPlayedAt: T0,
      },
      {
        kind: 'artist',
        key: 'main',
        label: 'Main',
        ids: ['ytm:artist:UC1'],
        at: T0,
        score: 1,
        skips: 0,
        plays: 1,
        lastPlayedAt: T0,
      },
      expect.objectContaining({ kind: 'artist', key: 'guest', ids: [], score: 0.5, plays: 1 }),
      expect.objectContaining({ kind: 'tag', key: 'rock', label: 'Rock', score: 1, plays: 1 }),
      expect.objectContaining({ kind: 'tag', key: 'indie', label: 'Indie', score: 1 }),
    ])
  })

  it('counts the share played, and skips by the share left unplayed', () => {
    const track = song(1)
    expect(effects(play(track, { playedMs: 100_000, completed: false }))).toMatchObject({
      'track:youtube:track:video1': { score: 0.5, skips: 0 },
    })
    expect(effects(play(track, { playedMs: 10_000, completed: false, skipped: true }))).toEqual({
      'track:youtube:track:video1': { score: 0.05, skips: 0.95 },
      'artist:artist 1': { score: 0.05, skips: 0.95 },
    })
    const late = effects(play(track, { playedMs: 180_000, completed: false, skipped: true }))
    expect(late['track:youtube:track:video1']?.score).toBeCloseTo(0.9, 12)
    expect(late['track:youtube:track:video1']?.skips).toBeCloseTo(0.1, 12)
  })

  it('never counts a completed play as a skip', () => {
    expect(effects(play(song(1), { completed: true, skipped: true }))).toMatchObject({
      'track:youtube:track:video1': { score: 1, skips: 0 },
    })
  })

  it('measures a play of unknown length against a typical song', () => {
    const { durationMs: _length, ...rest } = play(song(1), { playedMs: 105_000, completed: false })
    expect(effects(rest)).toMatchObject({ 'track:youtube:track:video1': { score: 0.5 } })
  })

  it('scores likes and playlist adds, and cancels them at their own time', () => {
    const track = song(1)
    const playlistId = formatId('local', 'playlist', 'mine')
    const later = T0 + 30 * DAY
    expect(affinityContributions({ type: 'like', at: T0, track })[0]).toMatchObject({
      at: T0,
      score: DEFAULT_AFFINITY_WEIGHTS.like,
      plays: 0,
    })
    expect(
      affinityContributions({ type: 'unlike', at: later, likedAt: T0 + DAY, track })[0],
    ).toMatchObject({ at: T0 + DAY, score: -DEFAULT_AFFINITY_WEIGHTS.like })
    expect(
      affinityContributions({ type: 'playlist-add', at: T0, track, playlistId })[0],
    ).toMatchObject({ at: T0, score: DEFAULT_AFFINITY_WEIGHTS.playlistAdd })
    expect(
      affinityContributions({
        type: 'playlist-remove',
        at: later,
        addedAt: T0,
        track,
        playlistId,
      })[0],
    ).toMatchObject({ at: T0, score: -DEFAULT_AFFINITY_WEIGHTS.playlistAdd })
    expect(affinityContributions({ type: 'like', at: T0, track })[0]).not.toHaveProperty(
      'lastPlayedAt',
    )
  })

  it('credits each artist and tag once, and never a placeholder artist', () => {
    const track = song(1, {
      artists: [
        { name: 'Various Artists' },
        { name: 'Beyoncé' },
        { name: 'BEYONCE' },
        { name: 'Jay-Z' },
        { name: '' },
      ],
      tags: ['Hip-Hop', 'hip hop', 'R&B', ''],
    })
    expect(Object.keys(effects(play(track)))).toEqual([
      'track:youtube:track:video1',
      'artist:beyonce',
      'artist:jay z',
      'tag:hip hop',
      'tag:r&b',
    ])
    expect(effects(play(track))['artist:beyonce']?.score).toBe(1)
    expect(effects(play(track))['artist:jay z']?.score).toBe(0.5)
  })

  it('credits at most 8 artists and 10 tags', () => {
    const track = song(1, {
      artists: Array.from({ length: 12 }, (_, n) => ({ name: `Artist ${n}` })),
      tags: Array.from({ length: 15 }, (_, n) => `tag ${n}`),
    })
    const entries = affinityContributions(play(track))
    expect(entries.filter((one) => one.kind === 'artist')).toHaveLength(8)
    expect(entries.filter((one) => one.kind === 'tag')).toHaveLength(10)
  })

  it('takes its weights from the caller', () => {
    const weights = { ...DEFAULT_AFFINITY_WEIGHTS, play: 2, featuredArtist: 0 }
    const track = song(1, { artists: [{ name: 'A' }, { name: 'B' }] })
    const entries = affinityContributions(play(track), { weights })
    expect(entries.map((one) => one.score)).toEqual([2, 2, 0])
  })

  it.each<[string, ListeningSignal]>([
    ['a time that is not a number', play(song(1), { at: Number.NaN })],
    ['a negative time', play(song(1), { at: -1 })],
    ['a time past the last valid date', play(song(1), { at: 9e15 })],
    ['a negative time played', play(song(1), { playedMs: -1 })],
    ['a time played that is not a number', play(song(1), { playedMs: Number.NaN })],
    ['a length that is not a number', play(song(1), { durationMs: Number.POSITIVE_INFINITY })],
    ['an invalid track ID', play(song(1, { id: 'nope' as EntityId<'track'> }))],
    ['an album ID', play(song(1, { id: 'ytm:album:x' as EntityId<'track'> }))],
    [
      'an unlike without a valid like time',
      { type: 'unlike', at: T0, likedAt: -1, track: song(1) },
    ],
    [
      'a removal without a valid add time',
      {
        type: 'playlist-remove',
        at: T0,
        addedAt: Number.NaN,
        track: song(1),
        playlistId: formatId('local', 'playlist', 'mine'),
      },
    ],
    ['an unknown type', { type: 'share', at: T0, track: song(1) } as unknown as ListeningSignal],
  ])('contributes nothing for %s', (_name, signal) => {
    expect(affinityContributions(signal)).toEqual([])
  })

  it('counts a completed play sought to its end by what it played, without a skip', () => {
    expect(effects(play(song(1), { playedMs: 10_000, completed: true }))).toMatchObject({
      'track:youtube:track:video1': { score: 0.05, skips: 0 },
    })
  })

  it('credits nobody for a plain video or a podcast episode, which count for themselves', () => {
    for (const kind of ['video', 'episode'] as const) {
      expect(Object.keys(effects(play(song(1, { kind, tags: ['vlog'] }))))).toEqual([
        'track:youtube:track:video1',
      ])
    }
    expect(Object.keys(effects(play(song(1, { kind: 'music-video' }))))).toContain(
      'artist:artist 1',
    )
    const { kind: _kind, ...unknownKind } = song(1)
    expect(Object.keys(effects(play(unknownKind as Track)))).toContain('artist:artist 1')
  })

  it('names the audio that played and the song of a music video next to the track', () => {
    const audioId = formatId('ytm', 'track', 'matched')
    const spotify = song(1, { id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC') })
    const [matched] = affinityContributions(play(spotify, { stream: { source: 'ytm', audioId } }))
    expect(matched?.ids).toEqual([spotify.id, audioId])
    const songId = formatId('ytm', 'track', 'song')
    const video = song(2, { kind: 'music-video', songId })
    expect(affinityContributions({ type: 'like', at: T0, track: video })[0]?.ids).toEqual([
      video.id,
      songId,
    ])
  })

  it('refuses a signal dated after the clock it is told, and a take-back of one', () => {
    const track = song(1)
    expect(affinityContributions(play(track, { at: T0 + 1 }), { now: T0 })).toEqual([])
    expect(affinityContributions(play(track), { now: T0 })).toHaveLength(2)
    expect(
      affinityContributions({ type: 'unlike', at: T0, likedAt: T0 + DAY, track }, { now: T0 }),
    ).toEqual([])
    // A take-back made later of something from before counts.
    expect(
      affinityContributions({ type: 'unlike', at: T0 + DAY, likedAt: T0, track }, { now: T0 }),
    ).toHaveLength(2)
  })

  it('survives artists and tags of the wrong shape', () => {
    const track = { ...song(1), artists: [null, { name: 7 }, { name: 'Ok' }], tags: 'rock' }
    expect(Object.keys(effects(play(track as unknown as Track)))).toEqual([
      'track:youtube:track:video1',
      'artist:ok',
    ])
    expect(affinityContributions({ type: 'like', at: T0 } as unknown as ListeningSignal)).toEqual(
      [],
    )
  })
})

describe('mergeAffinity', () => {
  it('adds up contributions made at the same time', () => {
    expect(mergeAffinity(entry({ score: 1 }), entry({ score: 2, skips: 1, plays: 0 }))).toEqual(
      entry({ score: 3, skips: 1, plays: 1 }),
    )
  })

  it('decays the older one to the later time, in either order', () => {
    const older = entry({ at: T0, score: 4, skips: 2, plays: 2, lastPlayedAt: T0 })
    const newer = entry({ at: T0 + 14 * DAY, score: 1, plays: 1, lastPlayedAt: T0 + 14 * DAY })
    for (const merged of [mergeAffinity(older, newer), mergeAffinity(newer, older)]) {
      expect(merged.at).toBe(T0 + 14 * DAY)
      expect(merged.score).toBeCloseTo(3, 12)
      expect(merged.skips).toBeCloseTo(1, 12)
      expect(merged.plays).toBe(3)
      expect(merged.lastPlayedAt).toBe(T0 + 14 * DAY)
    }
  })

  it('keeps the later label unless it is empty, and the IDs of both, the later first', () => {
    const a = formatId('ytm', 'artist', 'UCa')
    const b = formatId('spotify', 'artist', 'b')
    const older = entry({ at: T0, label: 'band', ids: [a] })
    expect(mergeAffinity(older, entry({ at: T0 + 1, label: 'Band', ids: [b] }))).toMatchObject({
      label: 'Band',
      ids: [b, a],
    })
    expect(mergeAffinity(older, entry({ at: T0 + 1, label: '' })).label).toBe('band')
    // At equal times the second argument counts as the later one.
    expect(mergeAffinity(older, entry({ at: T0, label: 'BAND' })).label).toBe('BAND')
  })

  it('keeps one ID per entity and at most a handful', () => {
    const ytm = formatId('ytm', 'track', 'x')
    const yt = formatId('yt', 'track', 'x')
    const track = entry({ kind: 'track', key: 'youtube:track:x', ids: [ytm] })
    expect(mergeAffinity(track, { ...track, at: T0 + 1, ids: [yt] }).ids).toEqual([yt])
    const many = Array.from({ length: 12 }, (_, n) => formatId('ytm', 'artist', `UC${n}`))
    const merged = mergeAffinity(entry({ ids: many.slice(0, 6) }), entry({ ids: many.slice(6) }))
    expect(merged.ids).toHaveLength(MAX_AFFINITY_IDS)
  })

  it('cancels a like exactly, however long ago it was made', () => {
    const track = song(1)
    const liked = affinityContributions({ type: 'like', at: T0, track })
    const unliked = affinityContributions({
      type: 'unlike',
      at: T0 + 300 * DAY,
      likedAt: T0,
      track,
    })
    const merged = mergeAffinity(liked[0] as AffinityEntry, unliked[0] as AffinityEntry)
    expect(merged.score).toBe(0)
    expect(isEmptyAffinity(merged)).toBe(true)
  })

  it('adds up changes that take skips and plays away, exactly', () => {
    const away = entry({ score: -1, skips: -0.5, plays: -2 })
    const merged = mergeAffinity(away, away)
    expect(merged).toMatchObject({ score: -2, skips: -1, plays: -4 })
    expect(isEmptyAffinity(mergeAffinity(entry({ score: 2, skips: 1, plays: 4 }), merged))).toBe(
      true,
    )
  })

  it('refuses to merge different entries', () => {
    expect(() => mergeAffinity(entry(), entry({ key: 'other' }))).toThrow(RangeError)
    expect(() => mergeAffinity(entry(), entry({ kind: 'tag' }))).toThrow(RangeError)
  })
})

describe('affinityAt and affinityRank', () => {
  it('reads an entry decayed to a later time, never grown at an earlier one', () => {
    const one = entry({ score: 8, skips: 2 })
    expect(affinityAt(one, T0)).toEqual({ score: 8, skips: 2 })
    const later = affinityAt(one, T0 + 28 * DAY)
    expect(later.score).toBeCloseTo(2, 12)
    expect(later.skips).toBeCloseTo(0.5, 12)
    expect(affinityAt(one, T0 - 28 * DAY)).toEqual({ score: 8, skips: 2 })
  })

  it('orders entries by their affinity at any time', () => {
    const entries = [
      entry({ key: 'old favourite', at: T0, score: 10 }),
      entry({ key: 'recent', at: T0 + 30 * DAY, score: 3 }),
      entry({ key: 'fresh', at: T0 + 40 * DAY, score: 1 }),
      entry({ key: 'gone', at: T0, score: 0 }),
      entry({ key: 'disliked', at: T0, score: -1 }),
    ]
    const byRank = [...entries].sort((a, b) => affinityRank(b) - affinityRank(a))
    for (const now of [T0 + 40 * DAY, T0 + 100 * DAY, T0 + 2000 * DAY]) {
      const byScore = [...entries].sort(
        (a, b) => affinityAt(b, now).score - affinityAt(a, now).score,
      )
      expect(byRank.map((one) => one.key)).toEqual(byScore.map((one) => one.key))
    }
    expect(affinityRank(entry({ score: 0 }))).toBe(-Infinity)
    expect(affinityRank(entry({ score: -1 }))).toBe(-Infinity)
    expect(affinityRank(entry({ score: 1, at: HALF_LIFE }))).toBeCloseTo(1, 12)
  })
})

describe('reading entries', () => {
  it('never reads skips below none', () => {
    expect(affinityAt(entry({ skips: -1e-6 }), T0).skips).toBe(0)
  })

  it('scores an entry at a time, and orders scores best first, then by kind and key', () => {
    const score = (one: AffinityEntry, now: number): AffinityScore => affinityScoreAt(one, now)
    expect(score(entry({ score: 4 }), T0 + 14 * DAY).score).toBeCloseTo(2, 12)
    const scores = [
      score(entry({ key: 'b', score: 1 }), T0),
      score(entry({ kind: 'tag', key: 'a', score: 1 }), T0),
      score(entry({ key: 'c', score: 2 }), T0),
      score(entry({ key: 'a', score: 1 }), T0),
    ]
    expect(scores.sort(compareAffinityScores).map((one) => one.entry.key)).toEqual([
      'c',
      'a',
      'b',
      'a',
    ])
    expect(scores[3]?.entry.kind).toBe('tag')
  })

  it('keys a track ID, a name or a tag the way its entries are keyed', () => {
    expect(affinityKey('track', formatId('ytm', 'track', 'x'))).toBe('youtube:track:x')
    expect(affinityKey('track', 'youtube:track:x')).toBe('youtube:track:x')
    expect(affinityKey('artist', 'Radiohead - Topic')).toBe('radiohead')
    expect(affinityKey('artist', 'Various Artists')).toBeUndefined()
    expect(affinityKey('tag', 'Hip-Hop')).toBe('hip hop')
    expect(affinityKey('playlist' as 'tag', 'x')).toBeUndefined()
    expect(affinityEntryId('artist', 'radiohead')).toBe('artist|radiohead')
  })
})

describe('affinityCredits', () => {
  it('gives the first artist the whole weight, the others their share, and every tag all', () => {
    const track = song(1, {
      artists: [{ id: formatId('ytm', 'artist', 'UC1'), name: 'Main' }, { name: 'Guest' }],
      tags: ['Rock'],
    })
    expect(affinityCredits(track)).toEqual([
      { kind: 'artist', key: 'main', label: 'Main', ids: ['ytm:artist:UC1'], share: 1 },
      { kind: 'artist', key: 'guest', label: 'Guest', ids: [], share: 0.5 },
      { kind: 'tag', key: 'rock', label: 'Rock', ids: [], share: 1 },
    ])
    expect(
      affinityCredits(track, { ...DEFAULT_AFFINITY_WEIGHTS, featuredArtist: 0.25 })[1],
    ).toMatchObject({ share: 0.25 })
    expect(affinityCredits(null as unknown as Track)).toEqual([])
  })
})

describe('reattributeAffinity', () => {
  const before = song(1, { artists: [{ name: 'Artist 1' }], tags: ['rock'] })
  const after = song(1, {
    artists: [{ name: 'Guest' }, { name: 'Artist 1' }],
    tags: ['Jazz'],
  })
  const signals = (track: Track): ListeningSignal[] => [
    { type: 'like', at: T0, track },
    play(track, { at: T0 + DAY, playedMs: 50_000, completed: false, skipped: true }),
    play(track, { at: T0 + 2 * DAY }),
    {
      type: 'playlist-add',
      at: T0 + 3 * DAY,
      track,
      playlistId: formatId('local', 'playlist', 'p'),
    },
  ]

  /** The entries of `kind` in `index`, as `key` → score and skips at `now`, and plays. */
  function scores(index: AffinityIndex, now: number) {
    return Object.fromEntries(
      index
        .entries()
        .map((one) => [
          affinityEntryId(one.kind, one.key),
          { ...affinityAt(one, now), plays: one.plays },
        ]),
    )
  }

  it('moves a track’s affinity to its new credits as if they had been there all along', () => {
    const now = T0 + 10 * DAY
    const moved = new AffinityIndex({ now: () => now })
    moved.add(signals(before))
    const track = moved.get('track', before.id) as AffinityEntry
    moved.merge(reattributeAffinity(track, affinityCredits(before), affinityCredits(after)))
    const fresh = new AffinityIndex({ now: () => now })
    fresh.add(signals(after))
    const got = scores(moved, now)
    const want = scores(fresh, now)
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort())
    for (const [id, value] of Object.entries(want)) {
      expect(got[id]?.score, id).toBeCloseTo(value.score, 12)
      expect(got[id]?.skips, id).toBeCloseTo(value.skips, 12)
      expect(got[id]?.plays, id).toBe(value.plays)
    }
  })

  it('lets a take-back after a change of metadata cancel exactly what it takes back', () => {
    const affinity = new AffinityIndex({ now: () => T0 + DAY })
    affinity.add({ type: 'like', at: T0, track: before })
    const track = affinity.get('track', before.id) as AffinityEntry
    affinity.merge(reattributeAffinity(track, affinityCredits(before), affinityCredits(after)))
    affinity.add({ type: 'unlike', at: T0 + DAY, likedAt: T0, track: after })
    expect(affinity.entries()).toEqual([])
  })

  it('changes nothing when the credits stay, and only moves track entries', () => {
    const track = affinityContributions({ type: 'like', at: T0, track: before })[0] as AffinityEntry
    expect(reattributeAffinity(track, affinityCredits(before), affinityCredits(before))).toEqual([])
    expect(reattributeAffinity(entry(), affinityCredits(before), affinityCredits(after))).toEqual(
      [],
    )
  })

  it('keeps the plays with the artists and tags that stay, and moves the last play', () => {
    const [track] = affinityContributions(play(before, { at: T0 + DAY }))
    const changes = reattributeAffinity(
      track as AffinityEntry,
      affinityCredits(before),
      affinityCredits(after),
    )
    expect(changes).toEqual([
      expect.objectContaining({ key: 'artist 1', score: -0.5, plays: 0 }),
      expect.objectContaining({ key: 'rock', score: -1, plays: -1 }),
      expect.objectContaining({ key: 'guest', score: 1, plays: 1, lastPlayedAt: T0 + DAY }),
      expect.objectContaining({ key: 'jazz', label: 'Jazz', score: 1, plays: 1 }),
    ])
    expect(changes[1]).not.toHaveProperty('lastPlayedAt')
  })
})

describe('AffinityIndex', () => {
  function index(now = T0) {
    let clock = now
    const affinity = new AffinityIndex({ now: () => clock })
    return {
      affinity,
      advance(ms: number) {
        clock += ms
      },
    }
  }

  it('ranks tracks, artists and tags by their affinity now, on its own clock', () => {
    const { affinity, advance } = index()
    affinity.add([
      play(song(1, { tags: ['rock'] })),
      play(song(1, { tags: ['rock'] }), { at: T0 - 1 }),
      play(song(2, { tags: ['jazz'] })),
      { type: 'like', at: T0, track: song(3) },
    ])
    expect(affinity.top('track').map(({ entry: one }) => one.label)).toEqual([
      'Song 3',
      'Song 1',
      'Song 2',
    ])
    expect(affinity.top('tag').map(({ entry: one }) => one.key)).toEqual(['rock', 'jazz'])
    expect(affinity.top('artist', { limit: 1 }).map(({ entry: one }) => one.key)).toEqual([
      'artist 3',
    ])
    expect(affinity.score('track', 'youtube:track:video1')).toBeCloseTo(2, 6)
    advance(14 * DAY)
    expect(affinity.score('track', 'youtube:track:video1')).toBeCloseTo(1, 6)
    expect(affinity.top('track')[0]?.score).toBeCloseTo(1.5, 6)
    expect(affinity.score('track', 'youtube:track:video1', T0)).toBeCloseTo(2, 6)
    expect(affinity.score('artist', 'nobody')).toBe(0)
  })

  it('breaks ties by key, and leaves out entries without affinity', () => {
    const { affinity } = index()
    affinity.add([play(song(2)), play(song(1)), play(song(3), { playedMs: 0, completed: false })])
    expect(affinity.top('track').map(({ entry: one }) => one.key)).toEqual([
      'youtube:track:video1',
      'youtube:track:video2',
    ])
    expect(affinity.top('track', { limit: 0 })).toEqual([])
    expect(affinity.get('track', 'youtube:track:video3')).toMatchObject({ score: 0, plays: 1 })
  })

  it('reports skips next to the affinity', () => {
    const { affinity } = index()
    affinity.add(play(song(1), { playedMs: 20_000, completed: false, skipped: true }))
    expect(affinity.top('track')[0]).toMatchObject({ score: 0.1, skips: 0.9 })
  })

  it('forgets an entry once everything it held was taken back', () => {
    const { affinity } = index()
    const track = song(1)
    affinity.add({ type: 'like', at: T0, track })
    expect(affinity.size).toBe(2)
    affinity.add({ type: 'unlike', at: T0 + DAY, likedAt: T0, track })
    expect(affinity.size).toBe(0)
    expect(affinity.entries()).toEqual([])
  })

  it('merges a stored snapshot', () => {
    const { affinity } = index()
    affinity.add(play(song(1)))
    const copy = new AffinityIndex({ now: () => T0 })
    copy.merge(affinity.entries())
    expect(copy.entries('track')).toEqual(affinity.entries('track'))
    expect(copy.entries()).toHaveLength(2)
  })

  it('takes its own half-life and weights', () => {
    const affinity = new AffinityIndex({
      halfLifeMs: DAY,
      weights: { like: 10 },
      now: () => T0 + DAY,
    })
    expect(affinity.weights).toEqual({ ...DEFAULT_AFFINITY_WEIGHTS, like: 10 })
    affinity.add({ type: 'like', at: T0, track: song(1) })
    expect(affinity.score('track', 'youtube:track:video1')).toBeCloseTo(5, 12)
  })

  it('refuses a half-life or weight that is not a usable number', () => {
    expect(() => new AffinityIndex({ halfLifeMs: 0 })).toThrow(RangeError)
    expect(() => new AffinityIndex({ halfLifeMs: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => new AffinityIndex({ weights: { like: -1 } })).toThrow(RangeError)
    expect(() => new AffinityIndex({ weights: { play: Number.NaN } })).toThrow(RangeError)
  })

  it('refuses signals dated after its clock, so they neither freeze nor outrank anything', () => {
    const { affinity, advance } = index()
    const reference = new AffinityIndex({ now: () => T0 + 10 * DAY })
    // A like dated a year ahead, as from a backup made on a device whose clock ran ahead.
    affinity.add({ type: 'like', at: T0 + 365 * DAY, track: song(1) })
    expect(affinity.size).toBe(0)
    for (let day = 1; day <= 10; day++) {
      advance(DAY)
      const listen = play(song(1), { at: T0 + day * DAY })
      affinity.add(listen)
      reference.add(listen)
    }
    affinity.add(play(song(2), { at: T0 + 10 * DAY }))
    reference.add(play(song(2), { at: T0 + 10 * DAY }))
    expect(affinity.score('artist', 'Artist 1')).toBeCloseTo(
      reference.score('artist', 'Artist 1'),
      12,
    )
    expect(affinity.score('artist', 'Artist 1')).toBeGreaterThan(8)
    const byRank = (one: AffinityIndex) =>
      one
        .entries('artist')
        .sort((a, b) => affinityRank(b) - affinityRank(a))
        .map((entry) => entry.key)
    expect(byRank(affinity)).toEqual(byRank(reference))
  })

  it('counts an entry of a snapshot dated after its clock as dated now', () => {
    const { affinity, advance } = index()
    affinity.merge([entry({ at: T0 + 365 * DAY, score: 3, plays: 0 })])
    expect(affinity.get('artist', 'band')).toMatchObject({ at: T0, score: 3 })
    advance(14 * DAY)
    affinity.merge([entry({ at: T0 + 14 * DAY, score: 1, plays: 1 })])
    expect(affinity.score('artist', 'band')).toBeCloseTo(2.5, 12)
  })

  it('finds an entry by track ID, name or tag as well as by its key', () => {
    const { affinity } = index()
    const yt = song(1, { id: formatId('yt', 'track', 'video1'), tags: ['Hip-Hop'] })
    affinity.add(play(song(1, { artists: [{ name: 'Radiohead' }] })))
    affinity.add(play(yt, { at: T0 }))
    expect(affinity.get('track', yt.id)?.plays).toBe(2)
    expect(affinity.get('track', 'youtube:track:video1')?.plays).toBe(2)
    expect(affinity.score('artist', 'RadioheadVEVO')).toBe(1)
    expect(affinity.score('tag', 'hip hop')).toBe(1)
    expect(affinity.get('artist', 'Various Artists')).toBeUndefined()
    expect(affinity.scores('tag', ['HIP_HOP', 'jazz']).map((one) => one?.score)).toEqual([
      1,
      undefined,
    ])
  })

  it('reads through the AffinityReader interface', async () => {
    const { affinity, advance } = index()
    affinity.add([play(song(1)), play(song(2), { playedMs: 100_000, completed: false })])
    const reader = affinity.reader()
    advance(14 * DAY)
    expect((await reader.top('track', { limit: 1 })).map((one) => one.score)).toEqual([0.5])
    const [first] = await reader.top('track', { now: T0 })
    expect(first?.score).toBe(1)
    const [one, none] = await reader.scores('track', [song(2).id, 'nothing'], { now: T0 })
    expect(one?.score).toBe(0.5)
    expect(none).toBeUndefined()
    expect((await reader.scores('artist', ['Artist 1']))[0]?.score).toBeCloseTo(0.5, 12)
  })

  it('reads Date.now by default', () => {
    const affinity = new AffinityIndex()
    affinity.add(play(song(1), { at: Date.now() }))
    expect(affinity.score('track', 'youtube:track:video1')).toBeCloseTo(1, 3)
  })
})
