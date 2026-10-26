import { describe, expect, it } from 'vitest'
import { creep, playOf } from './fixtures/testing'
import {
  LASTFM_RULES,
  LISTENBRAINZ_RULES,
  playLengthMs,
  qualifiesForScrobble,
  SCROBBLE_LISTEN_CAP_MS,
  scrobbleThresholdMs,
  validLengthMs,
} from './rules'

const MINUTE = 60_000

describe('scrobbleThresholdMs', () => {
  it('asks for half the track, or 4 minutes when that comes first', () => {
    expect(scrobbleThresholdMs(3 * MINUTE)).toBe(1.5 * MINUTE)
    expect(scrobbleThresholdMs(8 * MINUTE)).toBe(4 * MINUTE)
    expect(scrobbleThresholdMs(60 * MINUTE)).toBe(SCROBBLE_LISTEN_CAP_MS)
    expect(scrobbleThresholdMs(40_000)).toBe(20_000)
  })

  it('asks for the whole 4 minutes when the length is unknown or not believable', () => {
    for (const length of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3e9]) {
      expect(scrobbleThresholdMs(length)).toBe(SCROBBLE_LISTEN_CAP_MS)
    }
  })
})

describe('qualifiesForScrobble', () => {
  const song = creep({ durationMs: 200_000 })

  it('counts a play heard for half the track', () => {
    expect(qualifiesForScrobble(playOf(song, 100_000), LASTFM_RULES)).toBe(true)
    expect(qualifiesForScrobble(playOf(song, 99_999), LASTFM_RULES)).toBe(false)
    expect(qualifiesForScrobble(playOf(song, 100_000), LISTENBRAINZ_RULES)).toBe(true)
    expect(qualifiesForScrobble(playOf(song, 99_999), LISTENBRAINZ_RULES)).toBe(false)
  })

  it('counts 4 minutes of a long track, however long', () => {
    const mix = creep({ durationMs: 60 * MINUTE })
    expect(qualifiesForScrobble(playOf(mix, 4 * MINUTE), LASTFM_RULES)).toBe(true)
    expect(qualifiesForScrobble(playOf(mix, 4 * MINUTE - 1), LISTENBRAINZ_RULES)).toBe(false)
  })

  it('takes the length the player knew before the metadata', () => {
    const play = playOf(creep({ durationMs: 600_000 }), 100_000, { durationMs: 200_000 })
    expect(playLengthMs(play)).toBe(200_000)
    expect(qualifiesForScrobble(play, LASTFM_RULES)).toBe(true)
    expect(playLengthMs(playOf(creep({ durationMs: 600_000 }), 0))).toBe(600_000)
  })

  it('wants a track longer than 30 seconds on Last.fm only', () => {
    const jingle = creep({ durationMs: 30_000 })
    expect(qualifiesForScrobble(playOf(jingle, 30_000), LASTFM_RULES)).toBe(false)
    expect(qualifiesForScrobble(playOf(jingle, 15_000), LISTENBRAINZ_RULES)).toBe(true)
    const short = creep({ durationMs: 31_000 })
    expect(qualifiesForScrobble(playOf(short, 15_500), LASTFM_RULES)).toBe(true)
  })

  it('needs 4 minutes when no length is known, which proves the track long enough', () => {
    const unknown = creep()
    delete unknown.durationMs
    expect(qualifiesForScrobble(playOf(unknown, 4 * MINUTE), LASTFM_RULES)).toBe(true)
    expect(qualifiesForScrobble(playOf(unknown, 3 * MINUTE), LISTENBRAINZ_RULES)).toBe(false)
  })

  it('counts nothing for a time heard that is not a number', () => {
    for (const playedMs of [Number.NaN, Number.POSITIVE_INFINITY, '120000' as unknown as number]) {
      expect(qualifiesForScrobble(playOf(song, playedMs), LISTENBRAINZ_RULES)).toBe(false)
    }
  })
})

describe('validLengthMs', () => {
  it('believes positive lengths up to 24 days', () => {
    expect(validLengthMs(1)).toBe(1)
    expect(validLengthMs(2_073_600_000)).toBe(2_073_600_000)
    expect(validLengthMs(2_073_600_001)).toBeUndefined()
    expect(validLengthMs('200000')).toBeUndefined()
  })
})
