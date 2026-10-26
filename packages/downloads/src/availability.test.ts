import { formatId, type Track } from '@fxm/core'
import { TEST_CAPABILITIES, testCandidate, testSpotifyTrack, testTrack } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { downloadAvailability, downloadLane, isDownloadableStream } from './availability'

type Tier = keyof typeof TEST_CAPABILITIES

function inTier(tier: Tier, mode: 'music' | 'all' = 'music') {
  return { capabilities: TEST_CAPABILITIES[tier], mode }
}

const youtube = testTrack('song')
const plainYouTube = testTrack('upload', { id: formatId('yt', 'track', 'upload'), source: 'yt' })
const spotify = testSpotifyTrack('hit')
const archive = testTrack('flac', {
  id: formatId('archive', 'track', 'item/a.flac'),
  source: 'archive',
})
const jamendo = testTrack('free', { id: formatId('jamendo', 'track', '123'), source: 'jamendo' })
const local = testTrack('mine', { id: formatId('local', 'track', 'abc'), source: 'local' })
const plugin = testTrack('radio', {
  id: formatId('plugin.radio-garden', 'track', 'x'),
  source: 'plugin.radio-garden',
})
const video = testTrack('vlog', { kind: 'video' })

describe('downloadAvailability', () => {
  it.each<[string, Track, Tier, boolean]>([
    ['a YouTube Music song with FXM Connect, desktop or Android', youtube, 'full', true],
    ['a YouTube Music song in the Lite tier', youtube, 'lite', false],
    ['a YouTube Music song without YouTube', youtube, 'free', false],
    ['a plain YouTube video with full access', plainYouTube, 'full', true],
    ['a Spotify track (its matched song) with full access', spotify, 'full', true],
    ['a Spotify track in the Lite tier', spotify, 'lite', false],
    ['an Internet Archive file anywhere', archive, 'free', true],
    ['an Internet Archive file in Lite', archive, 'lite', true],
    ['a Jamendo track anywhere', jamendo, 'free', true],
  ])('%s: %s', (_label, track, tier, available) => {
    expect(downloadAvailability(track, inTier(tier)).available).toBe(available)
  })

  it('is never offered in Lite for YouTube audio, and says why', () => {
    expect(downloadAvailability(youtube, inTier('lite'))).toEqual({
      available: false,
      reason: 'needs-full-access',
    })
  })

  it('leaves out local files, plugin sources and what the mode hides', () => {
    expect(downloadAvailability(local, inTier('full'))).toEqual({
      available: false,
      reason: 'local',
    })
    expect(downloadAvailability(plugin, inTier('full'))).toEqual({
      available: false,
      reason: 'unsupported-source',
    })
    expect(downloadAvailability(video, inTier('full', 'music'))).toEqual({
      available: false,
      reason: 'hidden',
    })
    expect(downloadAvailability(video, inTier('full', 'all'))).toEqual({ available: true })
  })

  it('offers only what the resolver can resolve', () => {
    const onlyArchive = { canResolve: (track: Pick<Track, 'source'>) => track.source === 'archive' }
    expect(downloadAvailability(archive, inTier('free'), onlyArchive)).toEqual({ available: true })
    expect(downloadAvailability(jamendo, inTier('free'), onlyArchive)).toEqual({
      available: false,
      reason: 'no-source',
    })
    expect(downloadAvailability(youtube, inTier('full'), onlyArchive)).toEqual({
      available: false,
      reason: 'no-source',
    })
    // Unreadable bytes are the more telling reason.
    expect(downloadAvailability(youtube, inTier('lite'), onlyArchive)).toEqual({
      available: false,
      reason: 'needs-full-access',
    })
    // A resolver that doesn't say resolves everything.
    expect(downloadAvailability(jamendo, inTier('free'), {})).toEqual({ available: true })
  })
})

describe('downloadLane', () => {
  it('puts everything that needs YouTube in one lane', () => {
    expect([youtube, plainYouTube, spotify, video].map(downloadLane)).toEqual([
      'youtube',
      'youtube',
      'youtube',
      'youtube',
    ])
    expect(downloadLane(archive)).toBe('archive')
    expect(downloadLane(jamendo)).toBe('jamendo')
  })
})

describe('isDownloadableStream', () => {
  const ytm = testCandidate('a')
  const free = testCandidate('item/a.flac', { source: 'archive' })

  it('takes only verified YouTube streams', () => {
    expect(isDownloadableStream(ytm, { protocol: 'progressive', fullLength: 'verified' })).toBe(
      true,
    )
    expect(isDownloadableStream(ytm, { protocol: 'progressive', fullLength: 'unverified' })).toBe(
      false,
    )
    expect(isDownloadableStream(ytm, { protocol: 'progressive', fullLength: 'capped' })).toBe(false)
  })

  it('takes unverified files from sources that never cap them', () => {
    expect(isDownloadableStream(free, { protocol: 'progressive', fullLength: 'unverified' })).toBe(
      true,
    )
    expect(isDownloadableStream(free, { protocol: 'progressive', fullLength: 'capped' })).toBe(
      false,
    )
  })

  it('never takes a manifest or a SABR stream', () => {
    for (const protocol of ['hls', 'dash', 'sabr'] as const) {
      expect(isDownloadableStream(free, { protocol, fullLength: 'verified' })).toBe(false)
    }
  })
})
