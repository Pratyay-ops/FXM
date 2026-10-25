import { type CatalogMode, formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  isMusicMode,
  isYouTubeRadioSeed,
  seedArtist,
  seedArtistMbid,
  seedArtistName,
  seedRef,
  seedTitle,
  youtubeRadioSeed,
} from './seeds'
import {
  fakeSongForVideo,
  fakeYouTubeSeed,
  spotifyTrack,
  testContext,
  verdictOf,
  ytmTrack,
} from './testing'

const music = testContext({ mode: 'music' })
const all = testContext({ mode: 'all' })
/** A mode from stale storage, which must get Music mode's rules. */
const stale = testContext({ mode: 'video' as CatalogMode })

const RADIOHEAD_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

describe('isMusicMode', () => {
  it('fails closed: anything but Music + Video is Music mode', () => {
    expect(isMusicMode('music')).toBe(true)
    expect(isMusicMode('all')).toBe(false)
    expect(isMusicMode('video' as CatalogMode)).toBe(true)
  })
})

describe('seedRef', () => {
  it('records a track and an artist', () => {
    const track = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead')
    expect(seedRef(track)).toEqual({
      type: 'track',
      id: track.id,
      name: 'Creep',
      artists: ['Radiohead'],
    })
    expect(seedRef({ name: 'Radiohead' })).toEqual({ type: 'artist', name: 'Radiohead' })
    const id = formatId('spotify', 'artist', '4Z8W4fKeB5YxbusRsdQVPb')
    expect(seedRef({ id, name: 'Radiohead' })).toEqual({ type: 'artist', id, name: 'Radiohead' })
  })
})

describe('seedArtistName, seedTitle and seedArtistMbid', () => {
  it('read the main artist without channel suffixes, and the title proper', () => {
    const video = ytmTrack(
      'a',
      'Radiohead - Creep (Official Music Video)',
      'RadioheadVEVO',
      'video',
    )
    expect(seedArtist(video)).toEqual({ name: 'RadioheadVEVO' })
    expect(seedArtistName(video)).toBe('Radiohead')
    expect(seedTitle(video)).toBe('Creep')
    expect(seedArtistName({ name: 'Radiohead - Topic' })).toBe('Radiohead')
    expect(seedTitle({ name: 'Radiohead' })).toBe('')
    expect(seedArtistName({ ...video, artists: [] })).toBe('')
  })

  it('read the MusicBrainz ID an artist seed carries, in its canonical form', () => {
    expect(seedArtistMbid({ name: 'Radiohead', mbid: RADIOHEAD_MBID.toUpperCase() })).toBe(
      RADIOHEAD_MBID,
    )
    expect(seedArtistMbid({ name: 'Radiohead', mbid: 'nope' })).toBeUndefined()
    expect(seedArtistMbid({ name: 'Radiohead' })).toBeUndefined()
  })
})

describe('isYouTubeRadioSeed', () => {
  it('follows the YouTube Music provider’s rules', () => {
    const song = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead')
    const video = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'video')
    expect(isYouTubeRadioSeed(song, 'music')).toBe(true)
    expect(isYouTubeRadioSeed(video, 'music')).toBe(false)
    expect(isYouTubeRadioSeed(video, 'all')).toBe(true)
    expect(isYouTubeRadioSeed(ytmTrack('a', 'A', 'B', 'episode'), 'all')).toBe(false)
    const spotify = spotifyTrack('70LcF31zb1H0PyJoS1Sx1r', 'Creep', 'Radiohead')
    expect(isYouTubeRadioSeed(spotify, 'music')).toBe(false)
    expect(isYouTubeRadioSeed({ ...spotify, externalIds: { ytm: 'XFkzRNyygfk' } }, 'music')).toBe(
      true,
    )
    const plainVideo = { ...spotify, externalIds: { yt: 'XFkzRNyygfk' } }
    expect(isYouTubeRadioSeed(plainVideo, 'music')).toBe(false)
    expect(isYouTubeRadioSeed(plainVideo, 'all')).toBe(true)
    expect(isYouTubeRadioSeed({ name: 'Radiohead' }, 'music')).toBe(false)
    const channel = formatId('ytm', 'artist', 'UCq19-LqvG35A-30oyAiPiqA')
    expect(isYouTubeRadioSeed({ id: channel, name: 'Radiohead' }, 'music')).toBe(true)
    const spotifyArtist = formatId('spotify', 'artist', '4Z8W4fKeB5YxbusRsdQVPb')
    expect(isYouTubeRadioSeed({ id: spotifyArtist, name: 'Radiohead' }, 'music')).toBe(false)
    expect(isYouTubeRadioSeed({ ...song, id: 'bad' as typeof song.id }, 'all')).toBe(false)
  })
})

describe('youtubeRadioSeed', () => {
  it('keeps songs, YouTube artists and anything in Music + Video mode', async () => {
    const song = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead')
    const video = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'music-video')
    const channel = { id: formatId('ytm', 'artist', 'UCq19-LqvG35A-30oyAiPiqA'), name: 'Radiohead' }
    expect(await youtubeRadioSeed(song, music)).toBe(song)
    expect(await youtubeRadioSeed(channel, music)).toBe(channel)
    expect(await youtubeRadioSeed(video, all)).toBe(video)
  })

  it('seeds Music mode with the song an official video links', async () => {
    const video = ytmTrack('omvOMVomvOM', 'Creep', 'Radiohead', 'music-video', {
      songId: formatId('ytm', 'track', 'atvATVatvAT'),
      durationMs: 280_000,
      album: { name: 'Pablo Honey' },
    })
    const seed = await youtubeRadioSeed(video, music)
    expect(seed).toEqual({
      id: formatId('ytm', 'track', 'atvATVatvAT'),
      source: 'ytm',
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
      artwork: [],
      kind: 'song',
    })
  })

  it('asks the video-to-song rule for an official video without a link, at any band', async () => {
    const video = ytmTrack('omvOMVomvOM', 'Creep', 'Radiohead', 'music-video')
    const song = ytmTrack('atvATVatvAT', 'Creep', 'Radiohead')
    const rule = fakeSongForVideo({ omvOMVomvOM: song }, 'suggest')
    expect(await youtubeRadioSeed(video, music, { songForVideo: rule })).toBe(song)
    expect(rule.calls).toEqual(['omvOMVomvOM'])
    expect(await youtubeRadioSeed(video, music, { songForVideo: fakeSongForVideo({}) })).toBeNull()
    const notASong = fakeSongForVideo({
      omvOMVomvOM: { song: video, via: 'match', verdict: verdictOf('auto') },
    })
    expect(await youtubeRadioSeed(video, music, { songForVideo: notASong })).toBeNull()
    expect(await youtubeRadioSeed(video, music)).toBeNull()
  })

  it('has no song seed for other videos and episodes in Music mode, or an unknown mode', async () => {
    const rule = fakeSongForVideo({})
    for (const ctx of [music, stale]) {
      for (const kind of ['video', 'episode'] as const) {
        const seed = ytmTrack('aaaaaaaaaaa', 'A', 'B', kind)
        expect(await youtubeRadioSeed(seed, ctx, { songForVideo: rule })).toBeNull()
      }
    }
    expect(rule.calls).toEqual([])
    // An unknown mode does not let a plain video seed the radio.
    expect(await youtubeRadioSeed(ytmTrack('aaaaaaaaaaa', 'A', 'B', 'video'), stale)).toBeNull()
  })

  it('asks the YouTube seed adapter for a seed without a YouTube ID, and checks its answer', async () => {
    const spotify = spotifyTrack('70LcF31zb1H0PyJoS1Sx1r', 'Creep', 'Radiohead')
    const song = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead')
    const finder = fakeYouTubeSeed(() => song)
    expect(await youtubeRadioSeed(spotify, music, { youtubeSeed: finder })).toBe(song)
    expect(finder.seeds).toEqual([spotify])
    const channel = { id: formatId('ytm', 'artist', 'UCq19-LqvG35A-30oyAiPiqA'), name: 'Radiohead' }
    const artists = fakeYouTubeSeed(() => channel)
    expect(
      await youtubeRadioSeed({ name: 'Radiohead', mbid: RADIOHEAD_MBID }, music, {
        youtubeSeed: artists,
      }),
    ).toBe(channel)
    // An answer YouTube Music radio cannot start from either is no seed.
    const video = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'video')
    expect(
      await youtubeRadioSeed(spotify, music, { youtubeSeed: fakeYouTubeSeed(() => video) }),
    ).toBeNull()
    expect(
      await youtubeRadioSeed(spotify, music, { youtubeSeed: fakeYouTubeSeed(() => null) }),
    ).toBeNull()
    expect(await youtubeRadioSeed(spotify, music)).toBeNull()
    expect(await youtubeRadioSeed({ name: 'Radiohead' }, music)).toBeNull()
  })
})
