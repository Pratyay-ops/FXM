import { describe, expect, it } from 'vitest'
import type { CatalogMode } from '../mode'
import type { Track } from '../model'
import { createQueue, setQueue, setQueueRepeat } from '../queue/queue'
import { createSeededRandom } from '../queue/random'
import type { ListeningSignal } from '../signals/signals'
import { trackKeys } from './identity'
import {
  buildRadioBatch,
  DEFAULT_RADIO_OPTIONS,
  nextRadioSeed,
  planRadioSeeds,
  playsUnattended,
  type RadioBatch,
  type RadioInput,
  type RadioOptions,
  radioShortfall,
  resolveRadioOptions,
} from './radio'
import { indexTaste } from './taste'
import {
  DAY,
  HOUR,
  like,
  NOW,
  play,
  profileOf,
  radio,
  reorder,
  spotify,
  ytm,
} from './test-fixtures'
import type { RecCandidate } from './types'

const MINUTE = 60_000

/** A song by `artist`, a different one for every `id`. */
const by = (artist: string, id: string, extra: Partial<Track> = {}) =>
  ytm(id, `${artist} ${id}`, artist, extra)

const titles = (tracks: readonly Track[]) => tracks.map((track) => track.title)
const artistsOf = (tracks: readonly Track[]) => tracks.map((track) => track.artists[0]?.name)

/** A play the user skipped after a few seconds, `ago` before now. */
const skip = (track: Track, ago: number) =>
  play(track, ago, { completed: false, skipped: true, playedMs: 4_000 })

// The session: Low Tide plays now; Harbor Lights, Static Bloom and Glass River played before it.
const lowTide = ytm('d1', 'Low Tide', 'Dune Theory')
const harbor = ytm('c1', 'Harbor Lights', 'Cinder')
const bloom = ytm('b1', 'Static Bloom', 'Basalt')
const glass = ytm('a1', 'Glass River', 'Aurora Lane')

const session = [play(harbor, 4 * MINUTE), play(bloom, 8 * MINUTE), play(glass, 12 * MINUTE)]

/** The seeds of a history, with Low Tide playing unless `current` says otherwise. */
function seedsOf(
  signals: readonly ListeningSignal[],
  {
    current = lowTide,
    mode = 'music',
    options = {},
  }: { current?: Track | null; mode?: CatalogMode; options?: Partial<RadioOptions> } = {},
) {
  const taste = indexTaste(profileOf(signals), NOW)
  return planRadioSeeds(taste, { mode, options, ...(current === null ? {} : { current }) })
}

const names = (seeds: ReturnType<typeof seedsOf>) => seeds.map((seed) => seed.ref.name)

describe('resolveRadioOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveRadioOptions()).toEqual(DEFAULT_RADIO_OPTIONS)
    expect(DEFAULT_RADIO_OPTIONS).toMatchObject({
      seedPlays: 5,
      minUpcoming: 3,
      batchSize: 4,
      noRepeatTracks: 50,
    })
  })

  it('reads numbers defensively', () => {
    const options = resolveRadioOptions({
      seedPlays: 2.7,
      minUpcoming: -1,
      batchSize: Number.NaN,
      noRepeatTracks: Number.POSITIVE_INFINITY,
      sessionGapMs: Number.POSITIVE_INFINITY,
      perArtistCap: Number.POSITIVE_INFINITY,
      lambda: 3,
      jitter: -0.1,
    })
    expect(options).toEqual({
      ...DEFAULT_RADIO_OPTIONS,
      seedPlays: 2,
      sessionGapMs: Number.POSITIVE_INFINITY,
      perArtistCap: Number.POSITIVE_INFINITY,
      lambda: 1,
    })
    expect(resolveRadioOptions({ seedPlays: '3' as never }).seedPlays).toBe(5)
  })
})

describe('radioShortfall', () => {
  const tracks = Array.from({ length: 6 }, (_, index) => by('Basalt', `q${index}`))
  const at = (index: number) => setQueue(createQueue(), tracks, { startIndex: index })

  it('asks for a batch once fewer than three tracks remain after the current one', () => {
    expect(radioShortfall(at(0))).toBe(0)
    // Three remain: enough.
    expect(radioShortfall(at(2))).toBe(0)
    expect(radioShortfall(at(3))).toBe(4)
    // The last track, also once it has ended: nothing remains.
    expect(radioShortfall(at(5))).toBe(4)
  })

  it('asks for nothing for an empty queue or while repeat is on', () => {
    expect(radioShortfall(createQueue())).toBe(0)
    expect(radioShortfall(setQueueRepeat(at(5), 'all'))).toBe(0)
    expect(radioShortfall(setQueueRepeat(at(5), 'one'))).toBe(0)
  })

  it('follows its options', () => {
    expect(radioShortfall(at(4), { minUpcoming: 1 })).toBe(0)
    expect(radioShortfall(at(5), { minUpcoming: 1, batchSize: 2 })).toBe(2)
  })
})

describe('planRadioSeeds', () => {
  it('grows from the last five plays of the session, the track playing now first', () => {
    const older = [play(by('Echo', 'e1'), 16 * MINUTE), play(by('Fable', 'f1'), 20 * MINUTE)]
    const seeds = seedsOf([...session, ...older])
    expect(names(seeds)).toEqual([
      'Low Tide',
      'Harbor Lights',
      'Static Bloom',
      'Glass River',
      'Echo e1',
    ])
    for (const seed of seeds) {
      expect(seed).toMatchObject({ parts: ['radio'], purposes: ['radio'] })
      expect(seed.seed).toHaveProperty('title', seed.ref.name)
    }
  })

  it('weighs a seed by its age and by how much the user likes it, from 0.2 to 1', () => {
    const seeds = seedsOf(session)
    // The plays the user listened to through, by age; the track playing now is new to them,
    // so they don't like it yet as much as those.
    const weights = seeds.map((seed) => seed.weight)
    expect(weights).toHaveLength(4)
    ;[0.5, 0.85, 0.7, 0.55].forEach((weight, index) => {
      expect(weights[index]).toBeCloseTo(weight, 3)
    })
    for (const seed of seedsOf([...session, ...[1, 2].map((day) => skip(glass, day * DAY))])) {
      expect(seed.weight).toBeGreaterThanOrEqual(0.2)
      expect(seed.weight).toBeLessThanOrEqual(1)
    }
  })

  it('weighs a liked play more, so likes retune what the radio grows from', () => {
    const weightOf = (seeds: ReturnType<typeof seedsOf>, name: string) =>
      seeds.find((seed) => seed.ref.name === name)?.weight ?? 0
    const plain = seedsOf(session)
    expect(weightOf(plain, 'Glass River')).toBeLessThan(weightOf(plain, 'Static Bloom'))
    const liked = seedsOf([...session, like(glass, 10 * MINUTE)])
    expect(weightOf(liked, 'Glass River')).toBeGreaterThan(weightOf(liked, 'Static Bloom'))
  })

  it('leaves out plays the user skipped, so skips retune what the radio grows from', () => {
    const seeds = seedsOf([
      play(harbor, 4 * MINUTE),
      skip(bloom, 8 * MINUTE),
      play(glass, 12 * MINUTE),
    ])
    expect(names(seeds)).toEqual(['Low Tide', 'Harbor Lights', 'Glass River'])
  })

  it('leaves out the track playing now only when the user skips it more than they listen', () => {
    // Skipped once, last week: it doesn't seed, Harbor Lights leads.
    expect(names(seedsOf([...session, skip(lowTide, 7 * DAY)]))[0]).toBe('Harbor Lights')
    // Never played before: it seeds.
    expect(names(seedsOf(session))[0]).toBe('Low Tide')
  })

  it('leaves out plays by an artist the user mostly skips', () => {
    const cinder = [1, 2, 3].map((day) => skip(by('Cinder', `x${day}`), day * DAY))
    expect(names(seedsOf([...session, ...cinder]))).toEqual([
      'Low Tide',
      'Static Bloom',
      'Glass River',
    ])
  })

  it('starts a new session after a long pause', () => {
    const earlier = play(by('Echo', 'e1'), 3 * HOUR)
    expect(names(seedsOf([...session, earlier]))).not.toContain('Echo e1')
    // Measured from the end of a play: a long mix doesn't end the session.
    const mix = play(by('Echo', 'mix', { durationMs: 2 * HOUR + 50 * MINUTE }), 3 * HOUR)
    expect(names(seedsOf([...session, mix]))).toContain('Echo mix')
    // Without a track playing, the session is the one of the newest play.
    const lastNight = session.map((one) => ({ ...one, at: one.at - 10 * HOUR }))
    expect(names(seedsOf(lastNight, { current: null }))).toEqual([
      'Harbor Lights',
      'Static Bloom',
      'Glass River',
    ])
    expect(names(seedsOf(session, { options: { sessionGapMs: 0 } }))).toEqual(['Low Tide'])
  })

  it('counts each song once, and only what the catalog mode allows', () => {
    const sameSong = spotify('sp1', 'Harbor Lights', 'Cinder')
    const video = by('Echo', 'v1', { kind: 'music-video' })
    const history = [...session, play(sameSong, 14 * MINUTE), play(video, 16 * MINUTE)]
    expect(names(seedsOf(history))).toEqual([
      'Low Tide',
      'Harbor Lights',
      'Static Bloom',
      'Glass River',
    ])
    expect(names(seedsOf(history, { mode: 'all' }))).toContain('Echo v1')
  })

  it('falls back to the newest play the user listened to when they skipped all the last ones', () => {
    const skips = [1, 2, 3, 4].map((step) => skip(by('Skip', `s${step}`), step * MINUTE))
    const seeds = seedsOf([...skips, play(glass, 6 * MINUTE), skip(lowTide, 7 * DAY)])
    expect(names(seeds)).toEqual(['Glass River'])
    expect(seeds[0]?.weight).toBeCloseTo(0.4, 6)
  })

  it('has nothing to grow from without plays', () => {
    expect(seedsOf([], { current: null })).toEqual([])
    expect(seedsOf(session, { options: { seedPlays: 0 } })).toEqual([])
  })
})

describe('nextRadioSeed', () => {
  const seeds = seedsOf(session)

  it('fetches the heaviest seed whose radio is not at hand, the newest on a tie', () => {
    const [lowTideSeed, harborSeed, bloomSeed] = seeds
    expect(nextRadioSeed(seeds, () => false)).toBe(harborSeed)
    expect(nextRadioSeed(seeds, (seed) => seed === harborSeed)).toBe(bloomSeed)
    const tied = seeds.map((seed) => ({ ...seed, weight: 0.5 }))
    expect(nextRadioSeed(tied, () => false)).toBe(tied[0])
    expect(nextRadioSeed(seeds, (seed) => seed !== lowTideSeed)).toBe(lowTideSeed)
    expect(nextRadioSeed(seeds, () => true)).toBeUndefined()
    expect(nextRadioSeed([], () => false)).toBeUndefined()
  })
})

describe('playsUnattended', () => {
  it('lets only tracks with audio of their own play unattended', () => {
    expect(playsUnattended(lowTide)).toBe(true)
    expect(playsUnattended({ source: 'archive' })).toBe(true)
    expect(playsUnattended({ source: 'spotify' })).toBe(false)
  })
})

describe('buildRadioBatch', () => {
  // What the sources suggest for two of the session's plays: each radio varied, and one song,
  // Kestrel's, that both suggest.
  const shared = by('Kestrel', 'k1')
  const tideRadio = [
    by('Iris Vale', 'i1'),
    shared,
    by('Iris Vale', 'i2'),
    by('Iris Vale', 'i3'),
    by('Juniper Coast', 'j1'),
    by('Lark Avenue', 'l1'),
    by('Mirror Lake', 'm1'),
  ]
  const harborRadio = [shared, by('Northern Fern', 'n1'), by('Orchid Static', 'o1')]

  function input(overrides: Partial<RadioInput> = {}, history = session): RadioInput {
    const profile = profileOf(history)
    const seeds = planRadioSeeds(indexTaste(profile, NOW), { mode: 'music', current: lowTide })
    const candidates = [...radio(lowTide, tideRadio), ...radio(harbor, harborRadio)]
    return { profile, seeds, candidates, queued: [lowTide], mode: 'music', now: NOW, ...overrides }
  }
  const scoreOf = (batch: RadioBatch, track: Track) =>
    batch.picks.find((pick) => pick.track.id === track.id)?.score
  const rankOf = (batch: RadioBatch, track: Track) =>
    batch.tracks.findIndex((one) => one.id === track.id)

  it('picks a batch from the radios of the seeds, songs they agree on first', () => {
    const batch = buildRadioBatch(input())
    expect(batch.tracks).toHaveLength(4)
    expect(batch.tracks[0]).toBe(shared)
    expect(batch.picks.map((pick) => pick.track)).toEqual(batch.tracks)
    // Both radios count: the batch blends them.
    expect(batch.tracks.some((track) => tideRadio.includes(track) && track !== shared)).toBe(true)
    expect(batch.tracks.some((track) => harborRadio.includes(track) && track !== shared)).toBe(true)
  })

  it('caps each artist, counting the tracks already up next', () => {
    const batch = buildRadioBatch(input({ count: 20 }))
    expect(artistsOf(batch.tracks).filter((name) => name === 'Iris Vale')).toHaveLength(2)
    const upNext = [by('Iris Vale', 'i9')]
    const after = buildRadioBatch(
      input({ count: 20, upcoming: upNext, queued: [lowTide, ...upNext] }),
    )
    expect(artistsOf(after.tracks).filter((name) => name === 'Iris Vale')).toHaveLength(1)
  })

  it('never repeats a song of the queue, of the last plays, or one left out', () => {
    const heardBefore = play(by('Juniper Coast', 'j1'), 3 * DAY)
    const history = [...session, heardBefore]
    const queued = [lowTide, shared]
    const exclude = trackKeys(by('Lark Avenue', 'l1'))
    const batch = buildRadioBatch(input({ queued, exclude, count: 20 }, history))
    expect(titles(batch.tracks)).not.toContain(shared.title)
    expect(titles(batch.tracks)).not.toContain('Juniper Coast j1')
    expect(titles(batch.tracks)).not.toContain('Lark Avenue l1')
    // Once it is more than N tracks back, a song may come again.
    const later = buildRadioBatch(
      input({ queued, count: 20, options: { noRepeatTracks: 3 } }, history),
    )
    expect(titles(later.tracks)).toContain('Juniper Coast j1')
  })

  it('leaves out what plays only through a match, and songs only a search could find', () => {
    const tideSeed = radio(lowTide, [shared])[0]?.seed as RecCandidate['seed']
    const fromSpotify: RecCandidate[] = [
      ...radio(
        lowTide,
        [spotify('sp-k1', 'Kestrel k1', 'Kestrel'), spotify('sp-z', 'Zed', 'Zinc')],
        {
          source: 'spotify',
        },
      ),
      {
        type: 'song-search',
        source: 'lastfm',
        part: 'station',
        seed: tideSeed,
        rank: 0,
        score: 1,
        title: 'Only A Name',
        artists: ['Somebody'],
      },
    ]
    const batch = buildRadioBatch(input({ count: 20 }))
    const more = buildRadioBatch(
      input({ count: 20, candidates: [...input().candidates, ...fromSpotify] }),
    )
    expect(titles(more.tracks)).not.toContain('Zed')
    expect(titles(more.tracks)).not.toContain('Only A Name')
    // Spotify's listing of a song YouTube Music suggests too makes it count more.
    expect(more.tracks).toContain(shared)
    expect(scoreOf(more, shared)).toBeGreaterThan(scoreOf(batch, shared) ?? 0)
    // Unless the app says Spotify's tracks play.
    const anything = buildRadioBatch(
      input({ count: 20, candidates: fromSpotify, playable: () => true }),
    )
    expect(titles(anything.tracks)).toContain('Zed')
  })

  it('counts only the candidates of its seeds', () => {
    const stranger = radio(by('Nobody', 'z1'), [by('Quiet Harbor', 'qh1')])
    expect(buildRadioBatch(input({ candidates: stranger })).tracks).toEqual([])
    expect(buildRadioBatch(input({ seeds: [] })).tracks).toEqual([])
  })

  it('retunes with skips: what the user mostly skips is left out', () => {
    const irisSkips = [1, 2].map((hours) => skip(by('Iris Vale', `old${hours}`), hours * HOUR))
    const before = buildRadioBatch(input({ count: 20 }))
    const after = buildRadioBatch(input({ count: 20 }, [...session, ...irisSkips]))
    expect(artistsOf(before.tracks)).toContain('Iris Vale')
    expect(artistsOf(after.tracks)).not.toContain('Iris Vale')
  })

  it('retunes with skips: an artist the user skipped once sinks', () => {
    const once = skip(by('Northern Fern', 'n0'), HOUR)
    const fern = by('Northern Fern', 'n1')
    const before = buildRadioBatch(input({ count: 20 }))
    const after = buildRadioBatch(input({ count: 20 }, [...session, once]))
    expect(scoreOf(after, fern)).toBeLessThan(scoreOf(before, fern) ?? 0)
  })

  it('retunes with likes: a liked artist rises', () => {
    const mirror = by('Mirror Lake', 'm1')
    const before = buildRadioBatch(input({ count: 20 }))
    const after = buildRadioBatch(
      input({ count: 20 }, [...session, like(by('Mirror Lake', 'm0'), HOUR)]),
    )
    expect(scoreOf(after, mirror)).toBeGreaterThan(scoreOf(before, mirror) ?? 0)
    expect(rankOf(after, mirror)).toBeLessThan(rankOf(before, mirror))
  })

  it('keeps to the catalog mode', () => {
    const video = by('Lark Avenue', 'lv', { kind: 'video' })
    const candidates = [...input().candidates, ...radio(lowTide, [video])]
    expect(buildRadioBatch(input({ candidates, count: 20 })).tracks).not.toContain(video)
    expect(buildRadioBatch(input({ candidates, count: 20, mode: 'all' })).tracks).toContain(video)
  })

  it('names the seed whose radio suggested each pick most strongly', () => {
    const batch = buildRadioBatch(input({ count: 20 }))
    const seedOf = (title: string) =>
      batch.picks.find((pick) => pick.track.title === title)?.seed.ref.name
    expect(seedOf('Northern Fern n1')).toBe('Harbor Lights')
    expect(seedOf('Lark Avenue l1')).toBe('Low Tide')
    // Harbor Lights weighs more, as a play the user heard through.
    expect(seedOf(shared.title)).toBe('Harbor Lights')
  })

  it('is deterministic: the same input gives the same batch, whatever the order', () => {
    const one = buildRadioBatch(input())
    expect(buildRadioBatch(input({ candidates: reorder(input().candidates) })).tracks).toEqual(
      one.tracks,
    )
    const seeded = () => buildRadioBatch(input({ random: createSeededRandom(7) })).tracks
    expect(seeded()).toEqual(seeded())
    // A taste index made at another time is not used.
    const stale = indexTaste(profileOf([]), NOW - HOUR)
    expect(buildRadioBatch(input({ taste: stale })).tracks).toEqual(one.tracks)
  })

  it('picks as many as asked', () => {
    expect(buildRadioBatch(input({ count: 1 })).tracks).toHaveLength(1)
    expect(buildRadioBatch(input({ count: 0 })).tracks).toEqual([])
    expect(buildRadioBatch(input({ count: 2.5 })).tracks).toHaveLength(2)
  })

  it('reads its input defensively', () => {
    const broken = [
      null,
      { type: 'track' },
      { type: 'track', seed: 'x' },
    ] as never as RecCandidate[]
    expect(buildRadioBatch(input({ candidates: broken })).tracks).toEqual([])
    const odd = { ...by('Iris Vale', 'odd'), artists: [{ name: '' }], tags: ['Dream Pop', 4] }
    const upcoming = [odd, { id: 'not an id' }] as never as Track[]
    expect(buildRadioBatch(input({ upcoming, count: 3 })).tracks).toHaveLength(3)
  })
})
