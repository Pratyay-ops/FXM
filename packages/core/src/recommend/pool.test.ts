import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import { recSeedOf } from './identity'
import {
  combineStrengths,
  DEFAULT_EVIDENCE_WEIGHTS,
  fitsMode,
  poolCandidates,
  pooledArtistCandidates,
} from './pool'
import { artist, radio, reorder, similarArtists, spotify, ytm } from './test-fixtures'
import type { RecCandidate } from './types'

const seed = ytm('s1', 'Copper Sun', 'Aurora Lane')
const harbor = ytm('v1', 'Harbor Lights', 'Basalt')
const harborSpotify = spotify('sp1', 'Harbor Lights - Remastered 2011', 'Basalt', {
  artwork: [{ url: 'https://example.test/sp1.jpg' }],
  popularity: 70,
  tags: ['Dream Pop'],
})

describe('poolCandidates', () => {
  it('merges listings of one song across sources and seeds', () => {
    const pool = poolCandidates(
      [
        ...radio(seed, [harbor, ytm('v2', 'Static Bloom', 'Cinder')]),
        ...radio(seed, [harborSpotify], { source: 'spotify' }),
        ...radio(artist('Aurora Lane'), [harbor], { source: 'lastfm', part: 'station' }),
      ],
      { mode: 'music' },
    )
    const song = pool.songs.find((one) => one.title === 'Harbor Lights')
    expect(pool.songs).toHaveLength(2)
    expect(song?.track?.id).toBe(harbor.id)
    expect(song?.keys).toEqual([
      'youtube:track:v1',
      'song:basalt|harbor lights',
      'spotify:track:sp1',
    ])
    expect(song?.evidence.map((one) => one.source)).toEqual(['spotify', 'ytm', 'lastfm'])
    expect(song?.popularity).toBe(70)
    expect(song?.tags).toEqual(['dream pop'])
  })

  it('combines evidence like independent votes, weighed by source and part', () => {
    const pool = poolCandidates(
      [
        ...radio(seed, [harbor]),
        ...radio(artist('Aurora Lane'), [harbor], { source: 'lastfm', part: 'station' }),
      ],
      { mode: 'music' },
    )
    const station = DEFAULT_EVIDENCE_WEIGHTS.sources.lastfm as number
    const part = DEFAULT_EVIDENCE_WEIGHTS.parts.station as number
    expect(pool.songs[0]?.similarity).toBeCloseTo(1 - (1 - 1) * (1 - station * part))
    expect(combineStrengths([0.5, 0.5])).toBeCloseTo(0.75)
    expect(combineStrengths([])).toBe(0)
    expect(combineStrengths([2, Number.NaN])).toBe(1)
  })

  it('keeps one piece of evidence per list: the strongest listing', () => {
    const pool = poolCandidates(
      radio(seed, [harbor, { ...harbor, id: formatId('yt', 'track', 'v1') }]),
      {
        mode: 'all',
      },
    )
    expect(pool.songs).toHaveLength(1)
    expect(pool.songs[0]?.evidence).toHaveLength(1)
    expect(pool.songs[0]?.evidence[0]?.rank).toBe(0)
  })

  it('scales evidence by the seed weight', () => {
    const pool = poolCandidates(radio(seed, [harbor]), { mode: 'music', seedWeight: () => 0.5 })
    expect(pool.songs[0]?.similarity).toBeCloseTo(0.5)
  })

  it('shows the listing that plays most directly, borrowing a cover it lacks', () => {
    const bare = { ...harbor, artwork: [] }
    const pool = poolCandidates(
      [...radio(seed, [harborSpotify], { source: 'spotify' }), ...radio(seed, [bare])],
      { mode: 'music' },
    )
    expect(pool.songs[0]?.track?.source).toBe('ytm')
    expect(pool.songs[0]?.track?.artwork).toEqual(harborSpotify.artwork)
  })

  it('never recommends a radio its own seed', () => {
    const pool = poolCandidates(
      radio(seed, [seed, { ...seed, id: formatId('spotify', 'track', 'x') }, harbor]),
      {
        mode: 'music',
      },
    )
    expect(pool.songs.map((song) => song.title)).toEqual(['Harbor Lights'])
  })

  it('holds songs only in Music mode, and anything but episodes in Music + Video', () => {
    const video = ytm('m1', 'Harbor Lights (Official Video)', 'Basalt', { kind: 'music-video' })
    const upload = ytm('u1', 'Harbor Lights cover', 'Someone', { kind: 'video' })
    const episode = ytm('e1', 'Talk', 'Host', { kind: 'episode' })
    const candidates = radio(seed, [video, upload, episode])
    expect(poolCandidates(candidates, { mode: 'music' }).songs).toEqual([])
    expect(
      poolCandidates(candidates, { mode: 'all' }).songs.map((song) => song.track?.kind),
    ).toEqual(['music-video', 'video'])
    expect(fitsMode({ ...video, songId: harbor.id }, 'music')).toBe(false)
  })

  it('pools song searches by song identity, and merges them with tracks of the same song', () => {
    const search: RecCandidate = {
      type: 'song-search',
      source: 'lastfm',
      part: 'station',
      seed: recSeedOf(seed),
      rank: 0,
      score: 1,
      title: 'Harbor Lights',
      artists: ['Basalt'],
      durationMs: 210_000,
      youtubeId: 'yt-harbor',
    }
    const alone = poolCandidates([search], { mode: 'music' })
    expect(alone.songs[0]?.track).toBeUndefined()
    expect(alone.songs[0]?.youtubeId).toBe('yt-harbor')
    expect(alone.songs[0]?.key).toBe('song:basalt|harbor lights')
    const merged = poolCandidates([search, ...radio(seed, [harbor])], { mode: 'music' })
    expect(merged.songs).toHaveLength(1)
    expect(merged.songs[0]?.track?.id).toBe(harbor.id)
    expect(merged.songs[0]?.youtubeId).toBeUndefined()
  })

  it('drops candidates it cannot read', () => {
    const pool = poolCandidates(
      [
        null as never,
        { type: 'track', source: 'ytm', part: 'radio', rank: 0, score: 1 } as never,
        { ...radio(seed, [harbor])[0], seed: null } as never,
        { ...radio(seed, [harbor])[0], track: { ...harbor, id: 'bad' } } as never,
        {
          type: 'song-search',
          source: 'x',
          part: 'y',
          seed: recSeedOf(seed),
          rank: 0,
          score: 1,
          title: '',
          artists: [],
        },
        { type: 'mystery' } as never,
        ...radio(seed, [harbor]),
      ],
      { mode: 'music' },
    )
    expect(pool.songs.map((song) => song.key)).toEqual(['youtube:track:v1'])
  })

  it('gives the same pool whatever the order of the candidates', () => {
    const candidates = [
      ...radio(seed, [harbor, ytm('v2', 'Static Bloom', 'Cinder'), ytm('v3', 'Glass', 'Dune')]),
      ...radio(seed, [harborSpotify, spotify('sp2', 'Static Bloom', 'Cinder')], {
        source: 'spotify',
      }),
      ...radio(artist('Aurora Lane'), [ytm('v3', 'Glass', 'Dune')], {
        source: 'lastfm',
        part: 'station',
      }),
    ]
    const keys = (pool: ReturnType<typeof poolCandidates>) =>
      pool.songs.map((song) => [song.key, song.similarity, song.track?.id])
    expect(keys(poolCandidates(reorder(candidates), { mode: 'music' }))).toEqual(
      keys(poolCandidates(candidates, { mode: 'music' })),
    )
  })
})

describe('pooledArtistCandidates', () => {
  it('pools similar artists by name, preferring a listing with an ID', () => {
    const withId: RecCandidate = {
      type: 'artist',
      source: 'spotify',
      part: 'similar-artists',
      seed: recSeedOf(seed),
      rank: 0,
      score: 1,
      artist: { name: 'Basalt', id: formatId('spotify', 'artist', 'b'), artwork: [] },
    }
    const artists = pooledArtistCandidates(
      [...similarArtists(seed, ['basalt', 'Cinder']), withId, { type: 'artist' } as never],
      { mode: 'music' },
    )
    expect(artists.map((one) => one.key)).toEqual(['basalt', 'cinder'])
    expect(artists[0]?.artist.id).toBe('spotify:artist:b')
    expect(artists[0]?.evidence.map((one) => one.source)).toEqual(['spotify', 'listenbrainz'])
  })
})
