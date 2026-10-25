import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { Track } from '../model'
import type { AudioCandidate, StreamOption } from '../providers'
import {
  ASSUMED_TRACK_MS,
  COMPLETED_PLAY_SHARE,
  playContextOf,
  playedShare,
  playStreamOf,
} from './play'

const song: Track = {
  id: formatId('ytm', 'track', 'song1'),
  source: 'ytm',
  title: 'Song',
  artists: [{ name: 'Band' }],
  artwork: [],
  kind: 'song',
  durationMs: 200_000,
}

const spotifyTrack: Track = {
  ...song,
  id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
  source: 'spotify',
}

function candidate(overrides: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    source: 'ytm',
    ref: 'matched1',
    kind: 'song',
    title: 'Song',
    artists: ['Band'],
    confidence: 0.95,
    evidence: ['isrc'],
    ...overrides,
  }
}

const opus: StreamOption = {
  url: 'https://media.test/song1',
  codec: 'opus',
  container: 'webm',
  media: 'audio',
  bitrateKbps: 160,
  tier: 'high',
  protocol: 'progressive',
  ipBound: true,
  fullLength: 'verified',
}

describe('playedShare', () => {
  it('measures the time played against the track length', () => {
    expect(playedShare({ playedMs: 50_000, durationMs: 200_000, completed: false })).toBe(0.25)
    expect(playedShare({ playedMs: 0, durationMs: 200_000, completed: false })).toBe(0)
  })

  it('counts a completed play as all of it, when it played at least half', () => {
    expect(COMPLETED_PLAY_SHARE).toBe(0.5)
    expect(playedShare({ playedMs: 100_000, durationMs: 200_000, completed: true })).toBe(1)
    expect(playedShare({ playedMs: 190_000, durationMs: 200_000, completed: true })).toBe(1)
  })

  it('counts a completed play that was sought to the end by what it played', () => {
    expect(playedShare({ playedMs: 3_000, durationMs: 200_000, completed: true })).toBe(0.015)
    expect(playedShare({ playedMs: 99_000, durationMs: 200_000, completed: true })).toBe(0.495)
  })

  it('trusts a completed play of unknown length, as in an imported history', () => {
    expect(playedShare({ playedMs: 3_000, completed: true })).toBe(1)
    expect(playedShare({ playedMs: 3_000, durationMs: Number.NaN, completed: true })).toBe(1)
  })

  it('never counts more than all of it, e.g. after seeking back', () => {
    expect(playedShare({ playedMs: 500_000, durationMs: 200_000, completed: false })).toBe(1)
  })

  it('measures against a typical song length when the length is unknown or useless', () => {
    expect(playedShare({ playedMs: ASSUMED_TRACK_MS / 2, completed: false })).toBe(0.5)
    expect(playedShare({ playedMs: ASSUMED_TRACK_MS / 2, durationMs: 0, completed: false })).toBe(
      0.5,
    )
    expect(playedShare({ playedMs: 30_000, completed: false }, 60_000)).toBe(0.5)
  })

  it('counts bad numbers as nothing', () => {
    expect(playedShare({ playedMs: Number.NaN, durationMs: 200_000, completed: false })).toBe(0)
    expect(playedShare({ playedMs: -5, durationMs: 200_000, completed: false })).toBe(0)
    expect(playedShare({ playedMs: 5, completed: false }, 0)).toBe(0)
  })
})

describe('playContextOf', () => {
  it('stores what each context links back to', () => {
    const album = formatId('ytm', 'album', 'MPREb_1')
    const playlist = formatId('local', 'playlist', 'mine')
    const artist = formatId('ytm', 'artist', 'UC1')
    expect(playContextOf({ type: 'album', id: album, title: 'Record' })).toEqual({
      type: 'album',
      id: album,
      title: 'Record',
    })
    expect(playContextOf({ type: 'playlist', id: playlist, title: 'Mine' })?.id).toBe(playlist)
    expect(playContextOf({ type: 'artist', id: artist, title: 'Band' })?.id).toBe(artist)
    expect(playContextOf({ type: 'radio', seed: song.id, title: 'Radio' })).toEqual({
      type: 'radio',
      id: song.id,
      title: 'Radio',
    })
    expect(playContextOf({ type: 'search', query: 'creep', title: 'creep' })).toEqual({
      type: 'search',
      id: 'creep',
      title: 'creep',
    })
    expect(playContextOf({ type: 'library', id: 'liked', title: 'Liked songs' })?.id).toBe('liked')
  })

  it('gives nothing without a context', () => {
    expect(playContextOf(undefined)).toBeUndefined()
  })
})

describe('playStreamOf', () => {
  it('names the track’s own source when no candidate was recorded', () => {
    expect(playStreamOf({ track: song })).toEqual({ source: 'ytm' })
  })

  it('describes the stream that played', () => {
    expect(playStreamOf({ track: song }, opus)).toEqual({
      source: 'ytm',
      codec: 'opus',
      container: 'webm',
      bitrateKbps: 160,
      tier: 'high',
      media: 'audio',
    })
  })

  it('names the matched song that played for a track without audio of its own', () => {
    expect(playStreamOf({ track: spotifyTrack, candidate: candidate() }, opus)).toMatchObject({
      source: 'ytm',
      audioId: 'ytm:track:matched1',
    })
  })

  it('leaves out the audio ID when the audio is the track itself, under either YouTube prefix', () => {
    const own = playStreamOf({ track: song, candidate: candidate({ ref: 'song1' }) })
    expect(own).toEqual({ source: 'ytm' })
    const plainYouTube: Track = { ...song, id: formatId('yt', 'track', 'song1'), source: 'yt' }
    expect(playStreamOf({ track: plainYouTube, candidate: candidate({ ref: 'song1' }) })).toEqual({
      source: 'ytm',
    })
  })

  it('leaves out what is unusable', () => {
    const noRef = playStreamOf({ track: spotifyTrack, candidate: candidate({ ref: '' }) })
    expect(noRef).toEqual({ source: 'ytm' })
    const { bitrateKbps: _bitrate, ...unknownBitrate } = opus
    expect(playStreamOf({ track: song }, unknownBitrate)).not.toHaveProperty('bitrateKbps')
    expect(playStreamOf({ track: song }, { ...opus, bitrateKbps: Number.NaN })).not.toHaveProperty(
      'bitrateKbps',
    )
  })
})
