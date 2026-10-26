import { type AudioCandidate, formatId, ownCandidate } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { video } from './fixtures/testing'
import { skippableVideoId } from './skippable'

const matchedSong: AudioCandidate = {
  source: 'ytm',
  ref: 'songVideo01',
  kind: 'song',
  title: 'Made-up Song',
  artists: ['Made-up Artist'],
  confidence: 0.94,
  evidence: ['title 0.98'],
}

describe('skippableVideoId', () => {
  it('names the video of a video item in Music + Video mode', () => {
    expect(skippableVideoId({ track: video('fxmVideoAAA') }, 'all')).toBe('fxmVideoAAA')
    const upload = video('fxmVideoBBB', { kind: 'video' })
    expect(skippableVideoId({ track: upload }, 'all')).toBe('fxmVideoBBB')
  })

  it('takes plain YouTube videos too', () => {
    const track = video('fxmVideoAAA', { id: formatId('yt', 'track', 'fxmVideoAAA'), source: 'yt' })
    expect(skippableVideoId({ track }, 'all')).toBe('fxmVideoAAA')
  })

  it('never names anything in Music mode', () => {
    expect(skippableVideoId({ track: video() }, 'music')).toBeUndefined()
    expect(
      skippableVideoId({ track: video('fxmVideoAAA', { kind: 'video' }) }, 'music'),
    ).toBeUndefined()
  })

  it('never names a song, an episode or a track from another source', () => {
    expect(
      skippableVideoId({ track: video('fxmVideoAAA', { kind: 'song' }) }, 'all'),
    ).toBeUndefined()
    expect(
      skippableVideoId({ track: video('fxmVideoAAA', { kind: 'episode' }) }, 'all'),
    ).toBeUndefined()
    const spotify = video('fxmVideoAAA', {
      id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
      source: 'spotify',
    })
    expect(skippableVideoId({ track: spotify }, 'all')).toBeUndefined()
  })

  it('needs a well-formed videoId', () => {
    const odd = video('fxmVideoAAA', { id: formatId('ytm', 'track', 'not-a-video-id') })
    expect(skippableVideoId({ track: odd }, 'all')).toBeUndefined()
    const album = video('fxmVideoAAA', { id: 'ytm:album:fxmVideoAAA' as never })
    expect(skippableVideoId({ track: album }, 'all')).toBeUndefined()
  })

  it("accepts the video's own audio as the recorded candidate", () => {
    const track = video('fxmVideoAAA')
    const own = ownCandidate(track)
    expect(own).toBeDefined()
    expect(
      skippableVideoId({ track, ...(own === undefined ? {} : { candidate: own }) }, 'all'),
    ).toBe('fxmVideoAAA')
    const viaYt = {
      ...matchedSong,
      source: 'yt' as const,
      ref: 'fxmVideoAAA',
      kind: 'music-video' as const,
    }
    expect(skippableVideoId({ track, candidate: viaYt }, 'all')).toBe('fxmVideoAAA')
  })

  it('names nothing when other audio plays in place of the video', () => {
    expect(skippableVideoId({ track: video(), candidate: matchedSong }, 'all')).toBeUndefined()
  })
})
