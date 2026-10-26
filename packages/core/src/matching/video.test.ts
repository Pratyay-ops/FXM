import { describe, expect, it } from 'vitest'
import type { Track } from '../model'
import { track } from './__fixtures__/tracks'
import { effectiveMatchBand, MATCHER_VERSION, type VideoMatchOptions } from './types'
import { matchVideoToSong } from './video'

const VIDEO = track('4NRXx6U8ABQ', 'The Weeknd - Blinding Lights (Official Video)', 'The Weeknd', {
  kind: 'music-video',
  seconds: 263,
})
const SONG = track('J7p4bzqLvCw', 'Blinding Lights', 'The Weeknd', {
  album: 'Blinding Lights',
  seconds: 202,
})
const AUTO: VideoMatchOptions = { auto: true }

describe('matchVideoToSong', () => {
  it('follows a song link without scoring, unless told to ignore it', () => {
    const linked = { ...VIDEO, songId: SONG.id }
    expect(matchVideoToSong(linked, [])).toEqual({
      band: 'auto',
      autoEligible: true,
      via: 'link',
      songId: 'ytm:track:J7p4bzqLvCw',
      candidates: [],
      autoBlockers: [],
      evidence: ['song link'],
      matcherVersion: MATCHER_VERSION,
    })
    const other = track('other', 'Blinding Lights', 'The Weeknd', {
      album: 'After Hours',
      seconds: 200,
    })
    const ignored = matchVideoToSong(linked, [other], { auto: true, ignoreLink: true })
    expect(ignored).toMatchObject({ via: 'match', songId: 'ytm:track:other', band: 'auto' })
  })

  it('maps an official video with an intro to its song', () => {
    const result = matchVideoToSong(VIDEO, [SONG], AUTO)
    expect(result).toMatchObject({
      band: 'auto',
      autoEligible: true,
      via: 'match',
      songId: 'ytm:track:J7p4bzqLvCw',
      autoBlockers: [],
    })
    expect(result.best).toMatchObject({ source: 'ytm', ref: 'J7p4bzqLvCw', durationMs: 202000 })
    expect(result.best?.evidence).toEqual([
      'title 1.00',
      'artist 1.00',
      'song -61.0s vs the video',
      'score 1.00',
    ])
    expect(result.best?.verdict).toEqual({ band: 'auto', blockers: [], matcherVersion: 1 })
    expect(result.evidence[0]).toBe('matched J7p4bzqLvCw')
  })

  it('only suggests while the Auto setting is off, with the same verdict', () => {
    const result = matchVideoToSong(VIDEO, [SONG])
    expect(result).toMatchObject({ band: 'suggest', autoEligible: true })
    expect(result.autoBlockers).toEqual(['setting-off'])
    expect(effectiveMatchBand(result.best?.verdict, true)).toBe('auto')
    const stored = { auto: 'true' } as unknown as VideoMatchOptions
    expect(matchVideoToSong(VIDEO, [SONG], stored).band).toBe('suggest')
  })

  it('never maps to a longer song, another version or another song', () => {
    const shortened = { ...VIDEO, durationMs: 150000 }
    expect(matchVideoToSong(shortened, [SONG], AUTO)).toEqual({
      band: 'none',
      autoEligible: false,
      via: 'none',
      candidates: [],
      autoBlockers: ['no-candidates'],
      evidence: ['no song passes'],
      matcherVersion: MATCHER_VERSION,
    })
    const live = track('live', 'Blinding Lights (Live)', 'The Weeknd', { seconds: 200 })
    const cover = track('cover', 'Blinding Lights', 'Some Band', { seconds: 200 })
    const other = track('other', 'Save Your Tears', 'The Weeknd', { seconds: 200 })
    expect(matchVideoToSong(VIDEO, [live, cover, other]).via).toBe('none')
  })

  it('never maps to a version with an uncredited featured artist', () => {
    const video = track('v', 'Sam Smith - Stay With Me (Official Video)', 'Sam Smith', {
      kind: 'music-video',
      seconds: 180,
    })
    const duet = track('duet', 'Stay With Me (feat. Mary J. Blige)', 'Sam Smith', { seconds: 174 })
    const result = matchVideoToSong(video, [duet], AUTO)
    expect(result).toMatchObject({ band: 'none', via: 'none', autoEligible: false })
    expect(result.songId).toBeUndefined()
    expect(result.candidates[0]?.confidence).toBeCloseTo(0.55)
    expect(result.candidates[0]?.evidence).toContain('uncredited feat. mary j. blige')
  })

  it('matches official music videos only', () => {
    const upload = { ...VIDEO, kind: 'video' as const }
    expect(matchVideoToSong(upload, [SONG], AUTO)).toMatchObject({
      band: 'none',
      via: 'none',
      evidence: ['not an official music video'],
    })
  })

  it('needs both durations', () => {
    const { durationMs: _, ...unknown } = VIDEO
    expect(matchVideoToSong(unknown, [SONG]).via).toBe('none')
    expect(matchVideoToSong({ ...VIDEO, durationMs: Number.NaN }, [SONG]).via).toBe('none')
    const { durationMs: __, ...noLength } = SONG
    expect(matchVideoToSong(VIDEO, [noLength]).via).toBe('none')
  })

  it('suggests when look-alike songs from different releases pass (rivals)', () => {
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 200 })
    const plain = track('lp', 'Blinding Lights', 'The Weeknd', { source: 'yt', seconds: 200 })
    const remix = track('remix', 'Blinding Lights (Remix)', 'The Weeknd', { seconds: 200 })
    const result = matchVideoToSong(VIDEO, [SONG, lp, plain, remix], AUTO)
    expect(result.candidates.map((c) => c.ref)).toEqual(['J7p4bzqLvCw', 'lp'])
    expect(result).toMatchObject({ band: 'suggest', via: 'match', autoBlockers: ['rivals'] })
    expect(result.songId).toBe('ytm:track:J7p4bzqLvCw')
  })

  it('needs a margin over a song of another version', () => {
    const edit = track('edit', 'Blinding Lights (Radio Edit)', 'The Weeknd', { seconds: 200 })
    expect(matchVideoToSong(VIDEO, [SONG, edit], AUTO).band).toBe('auto')
    const tight = matchVideoToSong(VIDEO, [SONG, edit], { auto: true, thresholds: { margin: 0.5 } })
    expect(tight.autoBlockers).toEqual(['margin'])
  })

  it('reads a title quoted after the artist', () => {
    const idol = track('ZRtdQ81jPUQ', 'YOASOBI「アイドル」 Official Music Video', 'YOASOBI', {
      kind: 'music-video',
      seconds: 226,
    })
    const song = track('m9SMT5ipbxk', 'アイドル', 'YOASOBI', { seconds: 214 })
    expect(matchVideoToSong(idol, [song]).songId).toBe('ytm:track:m9SMT5ipbxk')
  })

  it('skips anything but songs with valid IDs', () => {
    const omv = track('omv', 'Blinding Lights', 'The Weeknd', { kind: 'music-video', seconds: 200 })
    const bad = { ...SONG, id: 'bad' } as unknown as Track
    expect(matchVideoToSong(VIDEO, [omv, bad]).via).toBe('none')
  })

  it('reads its thresholds from the options, ignoring invalid ones', () => {
    const strict = matchVideoToSong({ ...VIDEO, durationMs: 200000 }, [SONG], {
      thresholds: { videoSlackMs: 1000 },
    })
    expect(strict.via).toBe('none')
    const broken = {
      thresholds: { videoTitle: null, videoSlackMs: -1 },
    } as unknown as VideoMatchOptions
    expect(matchVideoToSong(VIDEO, [SONG], broken).via).toBe('match')
  })
})
