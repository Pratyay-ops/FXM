import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { seedArtist, seedArtistName, seedRef, seedTitle, youtubeRadioSeed } from './seeds'
import { fakeSongForVideo, spotifyTrack, testContext, ytmTrack } from './testing'

const music = testContext({ mode: 'music' })
const all = testContext({ mode: 'all' })

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

describe('seedArtistName and seedTitle', () => {
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
})

describe('youtubeRadioSeed', () => {
  it('keeps songs, artists and anything in Music + Video mode', async () => {
    const song = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead')
    const video = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'music-video')
    const spotify = spotifyTrack('70LcF31zb1H0PyJoS1Sx1r', 'Creep', 'Radiohead')
    expect(await youtubeRadioSeed(song, music, undefined)).toBe(song)
    expect(await youtubeRadioSeed(spotify, music, undefined)).toBe(spotify)
    expect(await youtubeRadioSeed({ name: 'Radiohead' }, music, undefined)).toEqual({
      name: 'Radiohead',
    })
    expect(await youtubeRadioSeed(video, all, undefined)).toBe(video)
  })

  it('seeds Music mode with the song an official video links', async () => {
    const video = ytmTrack('omvOMVomvOM', 'Creep', 'Radiohead', 'music-video', {
      songId: formatId('ytm', 'track', 'atvATVatvAT'),
      durationMs: 280_000,
      album: { name: 'Pablo Honey' },
    })
    const seed = await youtubeRadioSeed(video, music, undefined)
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

  it('asks the video-to-song rule for an official video without a link', async () => {
    const video = ytmTrack('omvOMVomvOM', 'Creep', 'Radiohead', 'music-video')
    const song = ytmTrack('atvATVatvAT', 'Creep', 'Radiohead')
    const rule = fakeSongForVideo({ omvOMVomvOM: song })
    expect(await youtubeRadioSeed(video, music, rule)).toBe(song)
    expect(rule.calls).toEqual(['omvOMVomvOM'])
    expect(await youtubeRadioSeed(video, music, fakeSongForVideo({}))).toBeNull()
    const notASong = fakeSongForVideo({ omvOMVomvOM: video })
    expect(await youtubeRadioSeed(video, music, notASong)).toBeNull()
    expect(await youtubeRadioSeed(video, music, undefined)).toBeNull()
  })

  it('has no song seed for other videos and episodes in Music mode', async () => {
    const rule = fakeSongForVideo({})
    for (const kind of ['video', 'episode'] as const) {
      expect(await youtubeRadioSeed(ytmTrack('a', 'A', 'B', kind), music, rule)).toBeNull()
    }
    expect(rule.calls).toEqual([])
  })
})
