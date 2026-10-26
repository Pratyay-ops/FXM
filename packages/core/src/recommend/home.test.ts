import { describe, expect, it } from 'vitest'
import { entityKey, formatId } from '../ids'
import type { Shelf, Track } from '../model'
import { createSeededRandom } from '../queue/random'
import {
  buildHome,
  DEFAULT_HOME_OPTIONS,
  type HomeFeed,
  type HomeInput,
  type HomeShelf,
  resolveHomeOptions,
} from './home'
import { artistKeyOf, recSeedOf, trackKeys } from './identity'
import { planSeeds } from './seeds'
import { NO_STABLE_SHELVES, sanitizeStableShelves } from './stable'
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
  similarArtists,
  spotify,
  ytm,
} from './test-fixtures'
import type { RecCandidate } from './types'

// --- A listening history ------------------------------------------------------------------------

const a = (n: number) => ytm(`a${n}`, `Aurora Song ${n}`, 'Aurora Lane')
const b = (n: number) => ytm(`b${n}`, `Basalt Song ${n}`, 'Basalt')
const c = (n: number) => ytm(`c${n}`, `Cinder Song ${n}`, 'Cinder')
const d = (n: number) => ytm(`d${n}`, `Dune Song ${n}`, 'Dune Theory')
const e = (n: number) => ytm(`e${n}`, `Ember Song ${n}`, 'Ember Fold')
const o = (n: number) => ytm(`o${n}`, `Opal Song ${n}`, 'Opal Rivers')
/** Artists the user has never played. */
const NEW_ARTISTS = [
  'Fable Kin',
  'Glass Choir',
  'Halcyon',
  'Iris Vale',
  'Juniper Coast',
  'Kestrel',
  'Lumen Bay',
  'Moss Avenue',
]
const fresh = (artist: number, n: number) => {
  const name = NEW_ARTISTS[artist % NEW_ARTISTS.length] as string
  return ytm(`n${artist}x${n}`, `${name} Song ${n}`, name)
}
/** `count` songs by new artists, the artists taking turns, from the `from`-th one on. */
const newSongs = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const at = from + index
    return fresh(at % NEW_ARTISTS.length, Math.floor(at / NEW_ARTISTS.length) + 1)
  })

const history = [
  // Aurora Lane: the favourite, on repeat.
  ...[1, 2, 3, 4, 5, 6].map((day) => play(a(1), day * DAY)),
  play(a(1), HOUR),
  ...[2, 4, 6].map((day) => play(a(2), day * DAY + HOUR)),
  play(a(3), 8 * DAY),
  like(a(3), 8 * DAY),
  // Basalt: liked, played lately.
  play(b(1), 2 * DAY),
  play(b(1), 5 * DAY),
  like(b(1), 5 * DAY),
  // Cinder: a few plays two days ago.
  play(c(1), 2 * DAY + 2 * HOUR),
  play(c(1), 2 * DAY + 3 * HOUR),
  // Dune Theory and Opal Rivers: loved two months ago, not since.
  ...[60, 61, 62, 63, 64].map((day) => play(d(1), day * DAY)),
  ...[60, 62, 64, 66, 68].map((day) => play(d(2), day * DAY + HOUR)),
  ...[55, 56, 57].map((day) => play(d(3), day * DAY)),
  ...[40, 41, 42].map((day) => play(o(1), day * DAY)),
  ...[40, 43, 44].map((day) => play(o(2), day * DAY + HOUR)),
  // Ember Fold: skipped every time.
  ...[1, 2, 3].map((day) =>
    play(e(1), day * DAY + 5 * HOUR, { completed: false, skipped: true, playedMs: 4_000 }),
  ),
]
const profile = profileOf(history)

// --- What the sources suggest -------------------------------------------------------------------

const candidates: RecCandidate[] = [
  ...radio(a(1), [a(2), b(2), ...newSongs(0, 6), a(4), c(2), e(2), ...newSongs(6, 10), a(5), b(3)]),
  ...radio(
    a(1),
    [
      ...newSongs(0, 4).map((song) =>
        spotify(`sp-${song.id}`, song.title, song.artists[0]?.name ?? ''),
      ),
      spotify('sp-b2', 'Basalt Song 2 - Remastered', 'Basalt'),
      ...newSongs(16, 4).map((song) =>
        spotify(`sp-${song.id}`, song.title, song.artists[0]?.name ?? ''),
      ),
    ],
    { source: 'spotify' },
  ),
  ...radio(b(1), [b(4), b(5), a(6), ...newSongs(8, 14)]),
  ...radio(c(1), [c(3), c(4), ...newSongs(20, 12)]),
  ...radio(a(2), newSongs(32, 16)),
  ...similarArtists(a(1), ['Basalt', 'Fable Kin', 'Glass Choir']),
]

const spotifyHome: Shelf = {
  id: 'made-for-you',
  title: 'Made For You',
  items: [
    { type: 'track', track: spotify('sp-x', 'Somewhere', 'Halcyon') },
    {
      type: 'track',
      track: { ...ytm('vid', 'A Video', 'Halcyon'), kind: 'music-video' },
    },
  ],
}

const base: HomeInput = {
  profile,
  candidates,
  mode: 'music',
  now: NOW,
  sourceShelves: [
    { source: 'spotify', shelf: spotifyHome },
    {
      source: 'ytm',
      shelf: { id: 'charts', title: 'Charts', items: [{ type: 'track', track: a(9) }] },
    },
  ],
}

// --- Helpers ------------------------------------------------------------------------------------

function shelf<T extends HomeShelf['type']>(feed: HomeFeed, type: T) {
  return feed.shelves.find((one) => one.type === type) as
    | Extract<HomeShelf, { type: T }>
    | undefined
}

function tracksOf(one: HomeShelf | undefined): Track[] {
  if (one === undefined) return []
  if (one.type === 'daily-mixes')
    return one.mixes.flatMap((mix) => mix.tracks.map((item) => item.track))
  if (one.type === 'source')
    return one.shelf.items.flatMap((item) => (item.type === 'track' ? [item.track] : []))
  return one.items.map((item) => item.track)
}

function titles(one: HomeShelf | undefined): string[] {
  return tracksOf(one).map((track) => track.title)
}

/** The most tracks any one artist has in a list. */
function maxPerArtist(tracks: readonly Track[]): number {
  const counts = new Map<string, number>()
  for (const track of tracks) {
    for (const credit of track.artists) {
      const key = artistKeyOf(credit.name) as string
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return Math.max(0, ...counts.values())
}

const taste = indexTaste(profile, NOW)
const known = (track: Track) => taste.known(trackKeys(track))

// --- Tests --------------------------------------------------------------------------------------

describe('buildHome', () => {
  const feed = buildHome(base)

  it('builds the shelves in order', () => {
    expect(feed.coldStart).toBe(false)
    expect(feed.shelves.map((one) => one.type)).toEqual([
      'quick-picks',
      'daily-mixes',
      'discover',
      'because',
      'because',
      'because',
      'on-repeat',
      'rediscover',
    ])
    expect(feed.shelves.map((one) => one.title)).toEqual([
      'Quick picks',
      'Daily Mixes',
      'Discover',
      'Because you listened to Aurora Song 1',
      'Because you listened to Basalt Song 1',
      'Because you listened to Cinder Song 1',
      'On repeat',
      'Rediscover',
    ])
    expect(new Set(feed.shelves.map((one) => one.id)).size).toBe(feed.shelves.length)
  })

  it('is deterministic, whatever the order of the candidates', () => {
    expect(buildHome(base)).toEqual(feed)
    expect(buildHome({ ...base, candidates: reorder(candidates) })).toEqual(feed)
  })

  it('never shows a track on two of its shelves (the mixes are lists of their own)', () => {
    const seen = new Map<string, string>()
    for (const one of feed.shelves) {
      if (one.type === 'daily-mixes' || one.type === 'source') continue
      for (const track of tracksOf(one)) {
        for (const key of trackKeys(track)) {
          expect(seen.get(key), `${track.title} on ${one.id} and ${seen.get(key)}`).toBeUndefined()
          seen.set(key, one.id)
        }
      }
    }
  })

  it('caps every artist on every list, and repeats no song within one', () => {
    const caps: Record<string, number> = {
      'quick-picks': DEFAULT_HOME_OPTIONS.quickPicks.perArtistCap,
      discover: DEFAULT_HOME_OPTIONS.discover.perArtistCap,
      because: DEFAULT_HOME_OPTIONS.because.perArtistCap,
      'on-repeat': DEFAULT_HOME_OPTIONS.onRepeat.perArtistCap,
      rediscover: DEFAULT_HOME_OPTIONS.rediscover.perArtistCap,
    }
    for (const one of feed.shelves) {
      if (one.type === 'daily-mixes') {
        for (const mix of one.mixes) {
          const tracks = mix.tracks.map((item) => item.track)
          expect(maxPerArtist(tracks)).toBeLessThanOrEqual(DEFAULT_HOME_OPTIONS.mixes.perArtistCap)
          expect(new Set(tracks.map((track) => entityKey(track.id))).size).toBe(tracks.length)
        }
        continue
      }
      const tracks = tracksOf(one)
      expect(maxPerArtist(tracks)).toBeLessThanOrEqual(caps[one.type] ?? 0)
      expect(new Set(tracks.map((track) => entityKey(track.id))).size).toBe(tracks.length)
    }
  })

  it('keeps Quick picks to favourites and new songs, without what played in the last 12 hours', () => {
    const picks = shelf(feed, 'quick-picks')
    const tracks = tracksOf(picks)
    expect(tracks.length).toBeGreaterThanOrEqual(DEFAULT_HOME_OPTIONS.quickPicks.minItems)
    expect(tracks.length).toBeLessThanOrEqual(DEFAULT_HOME_OPTIONS.quickPicks.limit)
    expect(titles(picks)).not.toContain('Aurora Song 1')
    expect(tracks.some(known)).toBe(true)
    expect(tracks.some((track) => !known(track))).toBe(true)
    expect(picks?.items.every((item) => item.familiar === known(item.track))).toBe(true)
    // Ember Fold is skipped every time: it never makes Quick picks.
    expect(titles(picks).some((title) => title.startsWith('Ember'))).toBe(false)
  })

  it('fills Discover with songs the user never played, by artists they hardly know', () => {
    const discover = shelf(feed, 'discover')
    const tracks = tracksOf(discover)
    expect(discover?.period).toBe('2026-W44')
    expect(tracks.length).toBeGreaterThanOrEqual(DEFAULT_HOME_OPTIONS.discover.minItems)
    expect(tracks.some(known)).toBe(false)
    expect(titles(discover).some((title) => title.startsWith('Aurora'))).toBe(false)
    expect(discover?.items.every((item) => !item.familiar)).toBe(true)
  })

  it('grows Because you listened from the latest plays, with songs new to the user', () => {
    const because = feed.shelves.filter((one) => one.type === 'because')
    expect(because.map((one) => one.seed.name)).toEqual([
      'Aurora Song 1',
      'Basalt Song 1',
      'Cinder Song 1',
    ])
    expect(because[0]?.id).toBe('because:track:youtube:track:a1')
    for (const one of because) {
      expect(tracksOf(one).length).toBeGreaterThanOrEqual(DEFAULT_HOME_OPTIONS.because.minItems)
      expect(tracksOf(one).length).toBeLessThanOrEqual(DEFAULT_HOME_OPTIONS.because.limit)
      expect(tracksOf(one).some(known)).toBe(false)
    }
    // Each shelf holds what its seed's radio suggested.
    const suggestedFor = (seed: Track) =>
      new Set(
        candidates.flatMap((one) =>
          one.type === 'track' && one.seed.id === seed.id ? [one.track.title] : [],
        ),
      )
    expect(titles(because[1]).every((title) => suggestedFor(b(1)).has(title))).toBe(true)
    expect(titles(because[2]).every((title) => suggestedFor(c(1)).has(title))).toBe(true)
  })

  it('puts the songs played most this month On repeat', () => {
    // By affinity, with a little variety: Basalt Song 1 before Aurora Lane's second song.
    expect(titles(shelf(feed, 'on-repeat'))).toEqual([
      'Aurora Song 1',
      'Basalt Song 1',
      'Aurora Song 2',
      'Cinder Song 1',
    ])
  })

  it('brings back old favourites in Rediscover', () => {
    // At most two by Dune Theory: Dune Song 3 is left for Quick picks.
    expect(titles(shelf(feed, 'rediscover')).sort()).toEqual([
      'Dune Song 1',
      'Dune Song 2',
      'Opal Song 1',
      'Opal Song 2',
    ])
    expect(titles(shelf(feed, 'quick-picks'))).toContain('Dune Song 3')
  })

  it('mixes favourites with new songs in Daily Mixes, by artists the sources link', () => {
    const mixes = shelf(feed, 'daily-mixes')?.mixes ?? []
    expect(mixes.map((mix) => mix.id)).toEqual(['daily-mix-1'])
    const [first] = mixes
    expect(first?.title).toBe('Daily Mix 1')
    // Aurora Lane's radio suggests Basalt and Cinder: one cluster.
    expect(first?.artists).toEqual(['Aurora Lane', 'Basalt', 'Cinder'])
    // The mix opens with a favourite.
    expect(first?.tracks[0]?.familiar).toBe(true)
    const tracks = first?.tracks ?? []
    expect(tracks.length).toBeGreaterThanOrEqual(DEFAULT_HOME_OPTIONS.mixes.minItems)
    expect(tracks.length).toBeLessThanOrEqual(DEFAULT_HOME_OPTIONS.mixes.limit)
    const familiar = tracks.filter((item) => item.familiar).length
    expect(familiar).toBeGreaterThan(0)
    expect(familiar).toBeLessThanOrEqual(DEFAULT_HOME_OPTIONS.mixes.limit * 0.5)
    expect(tracks.some((item) => !item.familiar)).toBe(true)
  })

  it("shows Spotify's own sections only with a connected account, in the mode", () => {
    expect(feed.shelves.some((one) => one.type === 'source')).toBe(false)
    const connected = buildHome({ ...base, spotifyConnected: true })
    const sections = connected.shelves.filter((one) => one.type === 'source')
    expect(sections.map((one) => [one.id, one.title, one.source])).toEqual([
      ['spotify:made-for-you', 'Made For You', 'spotify'],
    ])
    expect(titles(sections[0])).toEqual(['Somewhere'])
    expect(connected.shelves.at(-1)?.type).toBe('source')
    const all = buildHome({ ...base, mode: 'all', spotifyConnected: true })
    expect(titles(all.shelves.find((one) => one.type === 'source'))).toEqual([
      'Somewhere',
      'A Video',
    ])
    const capped = buildHome({ ...base, spotifyConnected: true, options: { sourceShelves: 0 } })
    expect(capped.shelves.some((one) => one.type === 'source')).toBe(false)
  })

  it('holds songs only, in Music mode', () => {
    const video = { ...fresh(0, 9), kind: 'music-video' as const, title: 'Fable Kin Video' }
    const upload = { ...fresh(1, 9), kind: 'video' as const, title: 'Glass Choir Live Upload' }
    const withVideos = [...candidates, ...radio(a(1), [video, upload])]
    const music = buildHome({ ...base, candidates: withVideos })
    const all = buildHome({ ...base, candidates: withVideos, mode: 'all' })
    const everything = (home: HomeFeed) => home.shelves.flatMap((one) => tracksOf(one))
    expect(everything(music).every((track) => track.kind === 'song')).toBe(true)
    expect(everything(all).some((track) => track.kind !== 'song')).toBe(true)
  })

  it('counts a song played on another source as heard', () => {
    // The user played Fable Kin Song 1 on Spotify: its YouTube Music listing isn't new.
    const elsewhere = spotify('sp-f1', 'Fable Kin Song 1', 'Fable Kin')
    const home = buildHome({ ...base, profile: profileOf([...history, play(elsewhere, 3 * DAY)]) })
    expect(titles(shelf(home, 'discover'))).not.toContain('Fable Kin Song 1')
    for (const one of home.shelves.filter((item) => item.type === 'because')) {
      expect(titles(one)).not.toContain('Fable Kin Song 1')
    }
  })

  it('takes options, with the defaults for the rest', () => {
    const options = resolveHomeOptions({ quickPicks: { limit: 5 }, sourceShelves: 2 })
    expect(options.quickPicks).toEqual({ ...DEFAULT_HOME_OPTIONS.quickPicks, limit: 5 })
    expect(options.sourceShelves).toBe(2)
    expect(options.discover).toEqual(DEFAULT_HOME_OPTIONS.discover)
    const small = buildHome({ ...base, options: { quickPicks: { limit: 5 } } })
    expect(tracksOf(shelf(small, 'quick-picks'))).toHaveLength(5)
  })

  it('uses the planned seeds when given, for Because you listened', () => {
    const seeds = planSeeds(taste, { mode: 'music', because: 1 })
    const home = buildHome({ ...base, seeds })
    expect(home.shelves.filter((one) => one.type === 'because')).toHaveLength(1)
  })

  it('uses a taste index made at its time, and indexes the profile itself otherwise', () => {
    expect(buildHome({ ...base, taste })).toEqual(feed)
    expect(buildHome({ ...base, taste: indexTaste({}, NOW - DAY) })).toEqual(feed)
  })
})

describe('a cold start', () => {
  it('asks for onboarding, and builds nothing from nothing', () => {
    const home = buildHome({ profile: {}, mode: 'music', now: NOW })
    expect(home.coldStart).toBe(true)
    expect(home.shelves).toEqual([])
    expect(home.stable).toEqual(NO_STABLE_SHELVES)
  })

  it('grows mixes and Discover from the onboarding picks', () => {
    const picks = {
      artists: [{ name: 'Fable Kin' }, { name: 'Glass Choir' }, { name: 'Halcyon' }],
      genres: ['Dream Pop'],
      at: NOW - HOUR,
    }
    const coldProfile = { picks }
    const seeds = planSeeds(indexTaste(coldProfile, NOW), { mode: 'music' })
    expect(seeds.map((seed) => seed.ref.name)).toEqual(['Fable Kin', 'Glass Choir', 'Halcyon'])
    const suggested: RecCandidate[] = seeds.flatMap((seed, index) =>
      radio(seed.seed, newSongs(index * 16, 16)),
    )
    const home = buildHome({
      profile: coldProfile,
      candidates: suggested,
      seeds,
      mode: 'music',
      now: NOW,
    })
    expect(home.coldStart).toBe(false)
    const mixes = shelf(home, 'daily-mixes')?.mixes ?? []
    expect(mixes.length).toBeGreaterThan(0)
    expect(mixes.every((mix) => mix.tracks.every((item) => !item.familiar))).toBe(true)
    expect(tracksOf(shelf(home, 'quick-picks')).length).toBeGreaterThan(0)
    expect(shelf(home, 'on-repeat')).toBeUndefined()
    // Discover is about artists the user hardly knows, and they just named the picked ones.
    const discover = tracksOf(shelf(home, 'discover'))
    expect(discover.length).toBeGreaterThanOrEqual(DEFAULT_HOME_OPTIONS.discover.minItems)
    const picked = new Set(picks.artists.map((one) => artistKeyOf(one.name)))
    expect(discover.filter((track) => picked.has(artistKeyOf(track.artists[0]?.name)))).toEqual([])
  })
})

describe('lists that stay put', () => {
  const first = buildHome(base)
  const stored = sanitizeStableShelves(JSON.parse(JSON.stringify(first.stable)))
  const other: RecCandidate[] = radio(a(1), newSongs(48, 32))

  it('keeps Discover and the mixes it built, to store', () => {
    expect(first.stable.entries.map((entry) => [entry.kind, entry.mode, entry.period])).toEqual([
      ['discover', 'music', '2026-W44'],
      ['mixes', 'music', '2026-10-26'],
    ])
    expect(stored).toEqual(JSON.parse(JSON.stringify(first.stable)))
  })

  it('keeps Discover all week, and changes it the next', () => {
    const later = buildHome({ ...base, candidates: other, now: NOW + 3 * DAY, stable: stored })
    expect(titles(shelf(later, 'discover'))).toEqual(titles(shelf(first, 'discover')))
    const nextWeek = buildHome({ ...base, candidates: other, now: NOW + 7 * DAY, stable: stored })
    expect(shelf(nextWeek, 'discover')?.period).toBe('2026-W45')
    expect(titles(shelf(nextWeek, 'discover'))).not.toEqual(titles(shelf(first, 'discover')))
  })

  it('keeps the mixes all day, and changes them the next', () => {
    const later = buildHome({ ...base, candidates: other, now: NOW + 3 * HOUR, stable: stored })
    expect(shelf(later, 'daily-mixes')).toEqual(shelf(first, 'daily-mixes'))
    const tomorrow = buildHome({ ...base, now: NOW + DAY, stable: stored })
    expect(tomorrow.stable.entries.find((entry) => entry.kind === 'mixes')?.period).toBe(
      '2026-10-27',
    )
  })

  it("keeps the other mode's lists while their period lasts", () => {
    const all = buildHome({ ...base, mode: 'all', stable: stored })
    expect(all.stable.entries.map((entry) => [entry.kind, entry.mode])).toEqual([
      ['discover', 'all'],
      ['mixes', 'all'],
      ['discover', 'music'],
      ['mixes', 'music'],
    ])
    const nextWeek = buildHome({ ...base, mode: 'all', now: NOW + 8 * DAY, stable: stored })
    expect(nextWeek.stable.entries.every((entry) => entry.mode === 'all')).toBe(true)
  })

  it('does not keep a Discover too small to last the week', () => {
    const few = buildHome({ ...base, options: { discover: { keepAtLeast: 50 } } })
    expect(tracksOf(shelf(few, 'discover')).length).toBeGreaterThan(0)
    expect(few.stable.entries.some((entry) => entry.kind === 'discover')).toBe(false)
  })

  it('changes Quick picks only with its random source', () => {
    const seeded = (seed: number) =>
      titles(shelf(buildHome({ ...base, random: createSeededRandom(seed) }), 'quick-picks'))
    expect(seeded(5)).toEqual(seeded(5))
    expect(titles(shelf(buildHome(base), 'quick-picks'))).toEqual(
      titles(shelf(first, 'quick-picks')),
    )
  })
})

describe('seed IDs on shelves', () => {
  it('names the Because shelf after an artist seed too', () => {
    const artistSeed = { name: 'Fable Kin', id: formatId('ytm', 'artist', 'UCf') }
    const seeds = [
      {
        key: 'artist:fable kin',
        seed: artistSeed,
        ref: recSeedOf(artistSeed),
        parts: ['radio' as const],
        purposes: ['because' as const],
        weight: 1,
      },
    ]
    const home = buildHome({
      ...base,
      seeds,
      candidates: radio(artistSeed, newSongs(64, 24)),
    })
    expect(home.shelves.find((one) => one.type === 'because')?.title).toBe(
      'Because you listened to Fable Kin',
    )
  })
})
