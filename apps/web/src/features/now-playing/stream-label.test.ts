import { formatId, type Track } from '@fxm/core'
import { testStream, testTrack } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import {
  describeStream,
  formatConfidence,
  formatLabel,
  isMatched,
  sourceName,
} from './stream-label'
import { spotifyTrack, testCandidate } from './testing'

const song = testTrack('Creep')

function details(description: ReturnType<typeof describeStream>): Record<string, string> {
  return Object.fromEntries(description.details.map(({ label, value }) => [label, value]))
}

describe('stream badge', () => {
  it('names the format and the source of a song that plays its own audio', () => {
    const description = describeStream(song, undefined, testStream('creep', { bitrateKbps: 141 }))
    expect(description.badge).toBe('Opus · YouTube Music')
    expect(description.match).toBeUndefined()
    expect(details(description)).toEqual({
      Format: 'Opus, 141 kbps',
      Quality: 'High',
      File: 'WebM',
      Source: 'YouTube Music',
    })
  })

  it('labels the muxed fallback as audio from a 360p video', () => {
    const stream = testStream('creep', {
      codec: 'aac',
      container: 'mp4',
      media: 'muxed-video',
      bitrateKbps: 96,
      tier: 'normal',
    })
    const description = describeStream(song, undefined, stream)
    expect(description.badge).toBe('AAC from 360p video · YouTube Music')
    expect(details(description).Format).toBe('AAC from 360p video, 96 kbps')
  })

  it('says a Spotify track was matched, and how sure the match is', () => {
    const track = spotifyTrack('Creep')
    const candidate = testCandidate('xyz', {
      confidence: 0.934,
      evidence: ['isrc', 'title 0.97'],
    })
    const description = describeStream(track, candidate, testStream('xyz'))
    expect(description.badge).toBe('Opus · YouTube Music')
    expect(description.match).toBe('Matched from Spotify · 0.93')
    expect(details(description)).toMatchObject({
      'Matched to': 'xyz title · xyz artist',
      Confidence: '0.93',
      Evidence: 'isrc · title 0.97',
    })
  })

  it('shows the match before the stream resolves, and nothing for an unmatched Spotify track', () => {
    const track = spotifyTrack('Creep')
    expect(describeStream(track, testCandidate('xyz'), undefined)).toMatchObject({
      badge: 'YouTube Music',
      match: 'Matched from Spotify · 0.93',
    })
    expect(describeStream(track, undefined, undefined)).toEqual({ details: [] })
  })

  it('names plain YouTube for a video found there, though its audio is a YouTube Music ID', () => {
    const video = testTrack('vid', { id: formatId('yt', 'track', 'vid'), source: 'yt' })
    const description = describeStream(video, testCandidate('vid'), testStream('vid'))
    expect(description.badge).toBe('Opus · YouTube')
    expect(description.match).toBeUndefined()
  })

  it('calls an official video’s song its song version, with a score only when matched', () => {
    const linked: Track = testTrack('OMV', {
      kind: 'music-video',
      songId: formatId('ytm', 'track', 'song'),
    })
    expect(describeStream(linked, testCandidate('song'), undefined).match).toBe('Song version')
    const unlinked: Track = testTrack('OMV', { kind: 'music-video' })
    expect(
      describeStream(unlinked, testCandidate('other', { confidence: 0.88 }), undefined).match,
    ).toBe('Song version · 0.88')
  })

  it('describes lossless audio from a free source', () => {
    const track = testTrack('Prelude', {
      id: formatId('archive', 'track', 'bach/prelude.flac'),
      source: 'archive',
    })
    const stream = testStream('prelude', {
      codec: 'flac',
      container: 'flac',
      tier: 'lossless',
      bitrateKbps: 912.4,
    })
    const description = describeStream(track, undefined, stream)
    expect(description.badge).toBe('FLAC · Internet Archive')
    expect(details(description)).toMatchObject({ Format: 'FLAC, 912 kbps', Quality: 'Lossless' })
  })

  it('leaves out a bitrate it doesn’t know', () => {
    const { bitrateKbps: _unknown, ...stream } = testStream('x')
    expect(details(describeStream(song, undefined, stream)).Format).toBe('Opus')
  })
})

describe('labels', () => {
  it('names every built-in source in plain words, and a plugin by its name', () => {
    expect(
      ['ytm', 'yt', 'spotify', 'archive', 'jamendo', 'local'].map((id) => sourceName(id as 'ytm')),
    ).toEqual(['YouTube Music', 'YouTube', 'Spotify', 'Internet Archive', 'Jamendo', 'Your files'])
    expect(sourceName('plugin.radio-garden')).toBe('radio-garden')
  })

  it('formats a confidence with two decimals, clamped to 0..1', () => {
    expect(formatConfidence(0.925)).toBe('0.93')
    expect(formatConfidence(1)).toBe('1.00')
    expect(formatConfidence(1.4)).toBe('1.00')
    expect(formatConfidence(-1)).toBe('0.00')
    expect(formatConfidence(Number.NaN)).toBe('0.00')
  })

  it('says “from video” for a muxed stream outside YouTube', () => {
    const stream = testStream('x', { codec: 'aac', media: 'muxed-video' })
    expect(formatLabel(stream, 'archive')).toBe('AAC from video')
    expect(formatLabel(stream, 'ytm')).toBe('AAC from 360p video')
  })

  it('tells matched audio from a track’s own', () => {
    expect(isMatched(song, undefined)).toBe(false)
    expect(isMatched(song, testCandidate('Creep'))).toBe(false)
    expect(isMatched(song, testCandidate('other'))).toBe(true)
    expect(isMatched(spotifyTrack('Creep'), testCandidate('Creep'))).toBe(true)
  })
})
