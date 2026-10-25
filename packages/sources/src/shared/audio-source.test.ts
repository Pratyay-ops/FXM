import { type QualityPrefs, type StreamOption, sanitizeQualityPrefs } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  type Comparable,
  MIN_CANDIDATE_CONFIDENCE,
  orderOptions,
  scoreCandidate,
  TEXT_ONLY_CAP,
  wordsOf,
} from './audio-source'

const creep: Comparable = { title: 'Creep', artists: ['Radiohead'], durationMs: 238_640 }

describe('wordsOf', () => {
  it('normalizes and splits on anything but letters and digits', () => {
    expect(wordsOf('Beyoncé – Halo! (feat. X & Y)')).toEqual(['beyonce', 'halo', 'feat', 'x', 'y'])
    expect(wordsOf('米津玄師「Lemon」')).toEqual(['米津玄師', 'lemon'])
    expect(wordsOf(' -- ')).toEqual([])
  })
})

describe('scoreCandidate', () => {
  it('caps a perfect text match below the Auto band', () => {
    expect(scoreCandidate(creep, { ...creep, durationMs: 236_666 })).toEqual({
      confidence: TEXT_ONLY_CAP,
      evidence: ['title 1.00', 'artist 1.00', 'duration -2.0s'],
      isrcMatch: false,
    })
    expect(TEXT_ONLY_CAP).toBeLessThan(0.8)
    expect(MIN_CANDIDATE_CONFIDENCE).toBe(0.6)
  })

  it('gives exactly 1 when the ISRCs are equal', () => {
    const score = scoreCandidate(
      { ...creep, isrc: 'gb-aye-92-00070' },
      { ...creep, title: 'Creep (Remastered)', isrc: 'GBAYE9200070' },
    )
    expect(score).toMatchObject({ confidence: 1, isrcMatch: true })
    expect(score.evidence[0]).toBe('isrc')
  })

  it('reads titles without presentation noise, qualifiers or featured artists', () => {
    const score = scoreCandidate(creep, {
      ...creep,
      title: 'Creep (feat. Someone) [Official Video]',
    })
    expect(score.evidence[0]).toBe('title 1.00')
  })

  it('costs a version tag on one side only by its strength', () => {
    const { durationMs: _durationMs, ...noDuration } = creep
    expect(scoreCandidate(creep, { ...creep, title: 'Creep - Live' })).toMatchObject({
      confidence: 0.55,
      evidence: expect.arrayContaining(['version live']),
    })
    expect(scoreCandidate(creep, { ...creep, live: true }).confidence).toBe(0.55)
    expect(scoreCandidate({ ...creep, live: true }, { ...creep, live: true }).confidence).toBe(
      TEXT_ONLY_CAP,
    )
    const radioEdit = { ...creep, title: 'Creep (Radio Edit)', durationMs: 250_640 }
    expect(scoreCandidate(creep, radioEdit)).toEqual({
      confidence: 0.64,
      evidence: ['title 1.00', 'artist 1.00', 'duration +12.0s', 'version radio edit'],
      isrcMatch: false,
    })
    expect(
      scoreCandidate(noDuration, { ...noDuration, title: 'Creep - 2009 Remaster' }).confidence,
    ).toBe(TEXT_ONLY_CAP)
  })

  it('costs a duration more than 10 s or 20 s off', () => {
    expect(scoreCandidate(creep, { ...creep, durationMs: 253_640 }).confidence).toBe(0.77)
    expect(scoreCandidate(creep, { ...creep, durationMs: 263_640 }).confidence).toBe(0.48)
    expect(scoreCandidate(creep, { ...creep, durationMs: 400_000 }).evidence).toContain(
      'duration +161.4s',
    )
  })

  it('caps a different title at 0.40 and an unknown artist at 0.45', () => {
    expect(
      scoreCandidate(creep, { ...creep, title: 'Karma Police' }).confidence,
    ).toBeLessThanOrEqual(0.4)
    expect(scoreCandidate(creep, { ...creep, artists: ['TLC'] }).confidence).toBe(0.45)
  })

  it('finds the main artist inside a combined credit', () => {
    const song: Comparable = { title: 'One Kiss', artists: ['Dua Lipa'], durationMs: 214_000 }
    const score = scoreCandidate(song, { ...song, artists: ['Calvin Harris, Dua Lipa'] })
    expect(score.evidence[1]).toBe('artist 1.00')
    expect(scoreCandidate({ ...song, artists: [] }, song).evidence[1]).toBe('artist 0.00')
  })
})

describe('orderOptions', () => {
  const option = (codec: StreamOption['codec'], bitrateKbps: number): StreamOption => ({
    url: `https://x.test/${codec}`,
    codec,
    container: codec === 'alac' ? 'm4a' : 'flac',
    media: 'audio',
    bitrateKbps,
    tier: 'lossless',
    protocol: 'progressive',
    ipBound: false,
    fullLength: 'unverified',
  })
  const prefs = (format: QualityPrefs['download']['format']) =>
    sanitizeQualityPrefs({ download: { format } })

  it('puts first, among equals, the codec the download format needs no conversion for', () => {
    const options = [option('flac', 900), option('alac', 900)]
    expect(orderOptions(options, prefs('alac')).map((entry) => entry.codec)).toEqual([
      'alac',
      'flac',
    ])
    expect(orderOptions(options, prefs('flac')).map((entry) => entry.codec)).toEqual([
      'flac',
      'alac',
    ])
    expect(orderOptions(options, prefs('original')).map((entry) => entry.codec)).toEqual([
      'flac',
      'alac',
    ])
  })

  it('never lets the hint override quality, and never changes the list it was given', () => {
    const options = [option('flac', 600), option('alac', 900)]
    expect(orderOptions(options, prefs('flac')).map((entry) => entry.codec)).toEqual([
      'alac',
      'flac',
    ])
    expect(options.map((entry) => entry.codec)).toEqual(['flac', 'alac'])
  })
})
