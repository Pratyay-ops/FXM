import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { creep, creepScrobble, playOf, T0 } from './fixtures/testing'
import {
  MAX_SCROBBLE_NAME_LENGTH,
  MIN_SCROBBLE_TIME_MS,
  sanitizeScrobble,
  scrobbleOf,
  scrobbleTrackOf,
} from './track'

describe('scrobbleTrackOf', () => {
  it('describes a song with its album, length, position and ISRC', () => {
    expect(scrobbleTrackOf(creep())).toEqual({
      artists: ['Radiohead'],
      title: 'Creep',
      album: 'Pablo Honey',
      durationMs: 239_000,
      trackNumber: 2,
      isrc: 'GBAYE9200070',
    })
  })

  it('keeps every credited artist in order, each once', () => {
    const track = creep({
      artists: [{ name: 'Calvin Harris' }, { name: ' Dua  Lipa ' }, { name: 'CALVIN HARRIS' }],
    })
    expect(scrobbleTrackOf(track)?.artists).toEqual(['Calvin Harris', 'Dua Lipa'])
  })

  it('skips placeholder artists and refuses a track that has no real one', () => {
    const credits = [{ name: 'Various Artists' }, { name: 'Daft Punk' }]
    expect(scrobbleTrackOf(creep({ artists: credits }))?.artists).toEqual(['Daft Punk'])
    expect(scrobbleTrackOf(creep({ artists: [{ name: 'Unknown Artist' }] }))).toBeNull()
    expect(scrobbleTrackOf(creep({ artists: [] }))).toBeNull()
    expect(scrobbleTrackOf(creep({ title: '   ' }))).toBeNull()
  })

  it('scrobbles songs and official music videos, never other videos or episodes', () => {
    expect(scrobbleTrackOf(creep({ kind: 'video' }))).toBeNull()
    expect(scrobbleTrackOf(creep({ kind: 'episode' }))).toBeNull()
    expect(scrobbleTrackOf(creep({ kind: 'music-video' }))).not.toBeNull()
  })

  it("cleans a music video's title and a YouTube channel's name", () => {
    const video = creep({
      kind: 'music-video',
      title: 'Radiohead - Creep (Official Music Video)',
      artists: [{ name: 'RadioheadVEVO' }],
    })
    expect(scrobbleTrackOf(video)).toMatchObject({ artists: ['Radiohead'], title: 'Creep' })
    const topic = creep({ artists: [{ name: 'Radiohead - Topic' }] })
    expect(scrobbleTrackOf(topic)?.artists).toEqual(['Radiohead'])
    // Only YouTube's channels carry those suffixes.
    const spotify = creep({
      id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
      source: 'spotify',
      artists: [{ name: 'Band VEVO' }],
    })
    expect(scrobbleTrackOf(spotify)?.artists).toEqual(['Band VEVO'])
  })

  it("keeps a song's title as it is, and a dash that names no artist", () => {
    const song = creep({ title: 'Creep - Remastered 2008' })
    expect(scrobbleTrackOf(song)?.title).toBe('Creep - Remastered 2008')
    const video = creep({ kind: 'music-video', title: 'Live - At the BBC (Official Video)' })
    expect(scrobbleTrackOf(video)?.title).toBe('Live - At the BBC')
  })

  it("names the Spotify recording: a Spotify track's own ID, or one matched to it", () => {
    const spotify = creep({
      id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
      source: 'spotify',
    })
    expect(scrobbleTrackOf(spotify)?.spotifyId).toBe('70LcF31zb1H0PyJoS1Sx1r')
    const matched = creep({ externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' } })
    expect(scrobbleTrackOf(matched)?.spotifyId).toBe('70LcF31zb1H0PyJoS1Sx1r')
    expect(scrobbleTrackOf(creep({ externalIds: { spotify: 'not an id' } }))).not.toHaveProperty(
      'spotifyId',
    )
  })

  it('leaves out what is unknown or not valid', () => {
    const track = scrobbleTrackOf(
      creep({ album: { name: ' ' }, durationMs: -5, trackNumber: 0, isrc: 'nope' }),
    )
    expect(track).toEqual({ artists: ['Radiohead'], title: 'Creep' })
  })

  it('cuts very long names, never inside a character', () => {
    const title = `${'a'.repeat(MAX_SCROBBLE_NAME_LENGTH - 1)}🎵 and more`
    const cut = scrobbleTrackOf(creep({ title }))?.title ?? ''
    expect(cut).toBe('a'.repeat(MAX_SCROBBLE_NAME_LENGTH - 1))
  })
})

describe('scrobbleOf', () => {
  it('is the track, the start, the time heard and the length the player knew', () => {
    const scrobble = scrobbleOf(playOf(creep(), 180_000.4, { durationMs: 238_500.6 }))
    expect(scrobble).toEqual({
      track: { ...creepScrobble().track, durationMs: 238_501 },
      startedAt: T0,
      playedMs: 180_000,
    })
  })

  it('says a radio play was not chosen by the user, and says nothing otherwise', () => {
    const radio = scrobbleOf(
      playOf(creep(), 180_000, { context: { type: 'radio', id: 'ytm:track:x' } }),
    )
    expect(radio?.chosenByUser).toBe(false)
    const album = scrobbleOf(
      playOf(creep(), 180_000, { context: { type: 'album', id: 'ytm:album:x' } }),
    )
    expect(album).not.toHaveProperty('chosenByUser')
  })

  it('refuses plays of tracks it does not scrobble, or with a start that is not a time', () => {
    expect(scrobbleOf(playOf(creep({ kind: 'video' }), 180_000))).toBeNull()
    expect(scrobbleOf(playOf(creep(), 180_000, { at: Number.NaN }))).toBeNull()
    expect(scrobbleOf(playOf(creep(), 180_000, { at: MIN_SCROBBLE_TIME_MS - 1 }))).toBeNull()
  })
})

describe('sanitizeScrobble', () => {
  it('keeps a scrobble as FXM stores it', () => {
    const scrobble = { ...creepScrobble(), chosenByUser: false }
    expect(sanitizeScrobble(structuredClone(scrobble))).toEqual(scrobble)
  })

  it('refuses anything without the required fields', () => {
    const bad = [
      null,
      'scrobble',
      { startedAt: T0 },
      { track: { artists: [], title: 'Creep' }, startedAt: T0 },
      { track: { artists: ['Radiohead'], title: ' Creep' }, startedAt: T0 },
      { track: { artists: ['Radiohead'], title: 'Creep' }, startedAt: T0 + 0.5 },
      { track: { artists: ['Radiohead'], title: 'Creep' }, startedAt: 1000 },
      { track: { artists: [1], title: 'Creep' }, startedAt: T0 },
    ]
    for (const value of bad) expect(sanitizeScrobble(value)).toBeNull()
  })

  it('drops optional fields that are not valid', () => {
    const value = {
      track: {
        artists: ['Radiohead'],
        title: 'Creep',
        durationMs: 'long',
        trackNumber: -1,
        isrc: 'gb-aye-92-00070',
        spotifyId: '?',
        extra: 'x',
      },
      startedAt: T0,
      playedMs: -4,
      chosenByUser: true,
    }
    expect(sanitizeScrobble(value)).toEqual({
      track: { artists: ['Radiohead'], title: 'Creep' },
      startedAt: T0,
    })
  })
})
