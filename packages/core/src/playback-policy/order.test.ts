import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { CatalogMode } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate, NetworkCapabilities } from '../providers'
import {
  candidateKey,
  canReachAudio,
  hasOwnAudio,
  isYouTubeCandidate,
  linkedSongCandidate,
  ownCandidate,
  type PlaybackPlanInput,
  type PlaybackStep,
  planPlayback,
  sameCandidate,
} from './order'
import { DEFAULT_PLAYBACK_SETTINGS, type PlaybackSettings } from './settings'

function track(source: Track['source'], id: string, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId(source, 'track', id),
    source,
    title: `Title ${id}`,
    artists: [{ name: 'Artist' }, { name: 'Guest' }],
    artwork: [],
    kind: 'song',
    durationMs: 200_000,
    ...overrides,
  }
}

function candidate(ref: string, overrides: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: ref,
    artists: ['Artist'],
    confidence: 0.9,
    evidence: ['test'],
    ...overrides,
  }
}

const song = track('ytm', 'song1')
const spotify = track('spotify', '4uLU6hMCjMI75M1A2tKUQC')
const archive = track('archive', 'item/track.flac')
const linkedVideo = track('ytm', 'video1', {
  kind: 'music-video',
  songId: formatId('ytm', 'track', 'song9'),
})
const unlinkedVideo = track('ytm', 'video2', { kind: 'music-video' })
const upload = track('yt', 'upload1', { kind: 'video' })

/** Each step as a short string, e.g. `candidate own ytm:song1` or `match song`. */
function describeSteps(steps: readonly PlaybackStep[]): string[] {
  return steps.map((step) => {
    if (step.type === 'candidate') {
      return `candidate ${step.origin} ${step.candidate.source}:${step.candidate.ref}`
    }
    if (step.type === 'match') return `match ${step.target}`
    return step.type
  })
}

function plan(
  input: Partial<PlaybackPlanInput> & { track: Track },
  settings: Partial<PlaybackSettings> = {},
  mode: CatalogMode = 'music',
): string[] {
  return describeSteps(
    planPlayback({ mode, settings: { ...DEFAULT_PLAYBACK_SETTINGS, ...settings }, ...input }),
  )
}

describe('planPlayback: the order of preference', () => {
  it('plays a YouTube Music song from its own video, after an offline copy', () => {
    expect(plan({ track: song })).toEqual(['offline', 'candidate own ytm:song1'])
  })

  it('matches a Spotify track to its song', () => {
    expect(plan({ track: spotify })).toEqual(['offline', 'match song'])
  })

  it('plays an Internet Archive item from its own file and never matches it to a lossless copy', () => {
    expect(plan({ track: archive }, { preferLossless: true })).toEqual([
      'offline',
      'candidate own archive:item/track.flac',
    ])
  })

  it('tries a lossless match first with "prefer lossless" on', () => {
    expect(plan({ track: song }, { preferLossless: true })).toEqual([
      'offline',
      'match lossless',
      'candidate own ytm:song1',
    ])
    expect(plan({ track: spotify }, { preferLossless: true })).toEqual([
      'offline',
      'match lossless',
      'match song',
    ])
  })

  it('tries the recorded candidate before anything else but the offline copy', () => {
    expect(
      plan({ track: spotify, recorded: candidate('matched') }, { preferLossless: true }),
    ).toEqual(['offline', 'candidate recorded ytm:matched', 'match lossless', 'match song'])
  })

  it('plays only a pin, then Invidious, when the user pinned a version', () => {
    const pinned = candidate('pinned')
    expect(
      plan({ track: spotify, pinned, recorded: candidate('old') }, { preferLossless: true }),
    ).toEqual(['offline', 'candidate pinned ytm:pinned'])
    expect(plan({ track: spotify, pinned }, { useInvidious: true })).toEqual([
      'offline',
      'candidate pinned ytm:pinned',
      'invidious',
    ])
    const lossless = candidate('item/a.flac', { source: 'archive' })
    expect(plan({ track: spotify, pinned: lossless }, { useInvidious: true })).toEqual([
      'offline',
      'candidate pinned archive:item/a.flac',
    ])
  })

  it('ignores a pin the mode does not let play', () => {
    const pinnedVideo = candidate('vid', { kind: 'video' })
    expect(plan({ track: spotify, pinned: pinnedVideo })).toEqual(['offline', 'match song'])
  })

  it('plays a music video in Music mode as its linked song, then its matched song', () => {
    expect(plan({ track: linkedVideo })).toEqual([
      'offline',
      'candidate linked-song ytm:song9',
      'match song',
    ])
    expect(plan({ track: unlinkedVideo })).toEqual(['offline', 'match song'])
  })

  it('plays videos as themselves in Music + Video mode, through the ytm audio source', () => {
    expect(plan({ track: linkedVideo }, {}, 'all')).toEqual(['offline', 'candidate own ytm:video1'])
    expect(plan({ track: upload }, {}, 'all')).toEqual(['offline', 'candidate own ytm:upload1'])
  })

  it('gives a track the mode hides nothing but the offline copy', () => {
    expect(plan({ track: upload })).toEqual(['offline'])
    expect(plan({ track: upload, recorded: candidate('upload1', { kind: 'video' }) })).toEqual([
      'offline',
    ])
  })

  it('leaves out the offline copy on request', () => {
    expect(plan({ track: song, skipOffline: true })).toEqual(['candidate own ytm:song1'])
  })

  it('never tries the same audio twice', () => {
    const recorded = candidate('song1')
    expect(plan({ track: song, recorded })).toEqual(['offline', 'candidate recorded ytm:song1'])
    const recordedYt = candidate('song9', { source: 'yt' })
    expect(plan({ track: linkedVideo, recorded: recordedYt })).toEqual([
      'offline',
      'candidate recorded yt:song9',
      'match song',
    ])
  })

  it('drops a recorded candidate the mode does not let play', () => {
    const recorded = candidate('video', { kind: 'music-video' })
    expect(plan({ track: spotify, recorded })).toEqual(['offline', 'match song'])
  })

  it('adds Invidious last, only when it is on and some audio is on YouTube', () => {
    expect(plan({ track: song }, { useInvidious: true })).toEqual([
      'offline',
      'candidate own ytm:song1',
      'invidious',
    ])
    expect(plan({ track: spotify }, { useInvidious: true })).toEqual([
      'offline',
      'match song',
      'invidious',
    ])
    expect(plan({ track: archive }, { useInvidious: true })).toEqual([
      'offline',
      'candidate own archive:item/track.flac',
    ])
  })
})

describe('candidates built from a track', () => {
  it('describe a track’s own audio', () => {
    expect(ownCandidate(song)).toEqual({
      source: 'ytm',
      ref: 'song1',
      kind: 'song',
      title: 'Title song1',
      artists: ['Artist', 'Guest'],
      durationMs: 200_000,
      confidence: 1,
      evidence: ['own audio'],
    })
    expect(ownCandidate(upload)).toMatchObject({ source: 'ytm', ref: 'upload1', kind: 'video' })
    const { durationMs: _drop, ...noDuration } = archive
    expect(ownCandidate(noDuration)).not.toHaveProperty('durationMs')
  })

  it('have no own audio for Spotify tracks or malformed IDs', () => {
    expect(ownCandidate(spotify)).toBeUndefined()
    expect(ownCandidate({ ...song, id: 'nonsense' as Track['id'] })).toBeUndefined()
  })

  it('describe a music video’s linked song on YouTube only', () => {
    expect(linkedSongCandidate(linkedVideo)).toEqual({
      source: 'ytm',
      ref: 'song9',
      kind: 'song',
      title: 'Title video1',
      artists: ['Artist', 'Guest'],
      confidence: 1,
      evidence: ['song-for-video link'],
    })
    expect(linkedSongCandidate(unlinkedVideo)).toBeUndefined()
    const spotifyLink = { ...unlinkedVideo, songId: formatId('spotify', 'track', 'abc') }
    expect(linkedSongCandidate(spotifyLink)).toBeUndefined()
    const ytLink = { ...unlinkedVideo, songId: formatId('yt', 'track', 'song8') }
    expect(linkedSongCandidate(ytLink)).toMatchObject({ source: 'ytm', ref: 'song8' })
  })
})

describe('candidate keys and sources', () => {
  it('give a YouTube video one key under either prefix', () => {
    expect(candidateKey(candidate('x'))).toBe('youtube:track:x')
    expect(sameCandidate(candidate('x'), candidate('x', { source: 'yt' }))).toBe(true)
    expect(sameCandidate(candidate('x'), candidate('y'))).toBe(false)
    expect(candidateKey({ source: 'archive', ref: 'a/b' })).toBe('archive:track:a/b')
  })

  it('give malformed candidates keys that match no valid one', () => {
    const bad = { source: 'nope' as AudioCandidate['source'], ref: 'x' }
    expect(candidateKey(bad)).toBe('invalid:nope:x')
    expect(candidateKey({ source: 'ytm', ref: '' })).toBe('invalid:ytm:')
  })

  it('know which sources have audio and which are YouTube', () => {
    expect(hasOwnAudio('spotify')).toBe(false)
    expect(hasOwnAudio('ytm')).toBe(true)
    expect(hasOwnAudio('plugin.radio')).toBe(true)
    expect(isYouTubeCandidate({ source: 'yt' })).toBe(true)
    expect(isYouTubeCandidate({ source: 'jamendo' })).toBe(false)
  })

  it('reach YouTube audio only with YouTube access, and never Spotify audio', () => {
    const caps = (youtube: 'none' | 'simple'): NetworkCapabilities => ({
      youtube,
      spotify: 'unreachable',
      mediaBytes: false,
      fileSystem: false,
    })
    expect(canReachAudio('ytm', caps('none'))).toBe(false)
    expect(canReachAudio('yt', caps('simple'))).toBe(true)
    expect(canReachAudio('archive', caps('none'))).toBe(true)
    expect(canReachAudio('spotify', caps('simple'))).toBe(false)
  })
})
