import { describe, expect, it } from 'vitest'
import type { Track } from '../model'
import { track } from './__fixtures__/tracks'
import { matchVideoToSong } from './video'

const VIDEO = track('4NRXx6U8ABQ', 'The Weeknd - Blinding Lights (Official Video)', 'The Weeknd', {
  kind: 'music-video',
  seconds: 263,
})
const SONG = track('J7p4bzqLvCw', 'Blinding Lights', 'The Weeknd', {
  album: 'Blinding Lights',
  seconds: 202,
})

describe('matchVideoToSong', () => {
  it('follows a song link without scoring', () => {
    const linked = { ...VIDEO, songId: SONG.id }
    expect(matchVideoToSong(linked, [])).toEqual({
      band: 'auto',
      via: 'link',
      songId: 'ytm:track:J7p4bzqLvCw',
      candidates: [],
      evidence: ['song link'],
    })
  })

  it('maps an official video with an intro to its song', () => {
    const result = matchVideoToSong(VIDEO, [SONG], { auto: true })
    expect(result).toMatchObject({ band: 'auto', via: 'match', songId: 'ytm:track:J7p4bzqLvCw' })
    expect(result.best).toMatchObject({ source: 'ytm', ref: 'J7p4bzqLvCw', durationMs: 202000 })
    expect(result.best?.evidence).toEqual([
      'title 1.00',
      'artist 1.00',
      'song -61.0s vs the video',
      'score 1.00',
    ])
    expect(result.evidence[0]).toBe('matched J7p4bzqLvCw')
  })

  it('only suggests while the Auto setting is off', () => {
    expect(matchVideoToSong(VIDEO, [SONG]).band).toBe('suggest')
  })

  it('never maps to a longer song, another version or another song', () => {
    const shortened = { ...VIDEO, durationMs: 150000 }
    expect(matchVideoToSong(shortened, [SONG])).toEqual({
      band: 'none',
      via: 'none',
      candidates: [],
      evidence: ['no song passes'],
    })
    const live = track('live', 'Blinding Lights (Live)', 'The Weeknd', { seconds: 200 })
    const cover = track('cover', 'Blinding Lights', 'Some Band', { seconds: 200 })
    const other = track('other', 'Save Your Tears', 'The Weeknd', { seconds: 200 })
    expect(matchVideoToSong(VIDEO, [live, cover, other]).via).toBe('none')
  })

  it('needs both durations', () => {
    const { durationMs: _, ...unknown } = VIDEO
    expect(matchVideoToSong(unknown, [SONG]).via).toBe('none')
    const { durationMs: __, ...noLength } = SONG
    expect(matchVideoToSong(VIDEO, [noLength]).via).toBe('none')
  })

  it('takes the best of several songs, then the first, once each', () => {
    const lp = track('lp', 'Blinding Lights', 'The Weeknd', { album: 'After Hours', seconds: 200 })
    const plain = track('lp', 'Blinding Lights', 'The Weeknd', { source: 'yt', seconds: 200 })
    const remix = track('remix', 'Blinding Lights (Remix)', 'The Weeknd', { seconds: 200 })
    const result = matchVideoToSong(VIDEO, [SONG, lp, plain, remix], { auto: true })
    expect(result.candidates.map((c) => c.ref)).toEqual(['J7p4bzqLvCw', 'lp'])
    expect(result.songId).toBe('ytm:track:J7p4bzqLvCw')
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

  it('reads its thresholds from the options', () => {
    const strict = matchVideoToSong({ ...VIDEO, durationMs: 200000 }, [SONG], {
      thresholds: { videoSlackMs: 1000 },
    })
    expect(strict.via).toBe('none')
  })
})
