import { type QualityPrefs, type StreamOption, sanitizeQualityPrefs } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  type Comparable,
  isLive,
  MIN_CANDIDATE_CONFIDENCE,
  orderOptions,
  provisionalScore,
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

describe('provisionalScore', () => {
  it('caps a perfect text match below the Auto band', () => {
    expect(provisionalScore(creep, { ...creep, durationMs: 236_666 })).toEqual({
      confidence: TEXT_ONLY_CAP,
      evidence: ['title 1.00', 'artist 1.00', 'duration -2.0s'],
      isrcVerified: false,
    })
    expect(TEXT_ONLY_CAP).toBeLessThan(0.8)
    expect(MIN_CANDIDATE_CONFIDENCE).toBe(0.6)
  })

  it('gives exactly 1 when the ISRCs are equal and the gate’s checks pass', () => {
    const score = provisionalScore(
      { ...creep, isrc: 'gb-aye-92-00070' },
      { ...creep, title: 'Creep (Remastered)', isrc: 'GBAYE9200070' },
    )
    expect(score).toMatchObject({ confidence: 1, isrcVerified: true })
    expect(score.evidence[0]).toBe('isrc')
    const { durationMs: _durationMs, ...noDuration } = creep
    expect(
      provisionalScore({ ...noDuration, isrc: 'GBAYE9200070' }, { ...creep, isrc: 'GBAYE9200070' }),
    ).toMatchObject({ confidence: 1, isrcVerified: true })
  })

  it('never trusts an ISRC that a different title, artist, length or version carries', () => {
    const song: Comparable = {
      title: 'Song',
      artists: ['Band'],
      durationMs: 200_000,
      isrc: 'USABC2400001',
    }
    // An uploader copied one ISRC onto every file of an item.
    const intro = provisionalScore(song, { ...song, title: 'Intro', durationMs: 110_000 })
    expect(intro).toEqual({
      confidence: 0,
      evidence: ['isrc conflict (title, duration)', 'title 0.00', 'artist 1.00', 'duration -90.0s'],
      isrcVerified: false,
    })
    const cases: Array<[Partial<Comparable>, string]> = [
      [{ artists: ['Someone Else'] }, 'isrc conflict (artist)'],
      [{ durationMs: 206_000 }, 'isrc conflict (duration)'],
      [{ title: 'Song - Live' }, 'isrc conflict (version)'],
      [{ live: true }, 'isrc conflict (version)'],
      [{ title: 'Song Two Three' }, 'isrc conflict (title)'],
    ]
    for (const [change, evidence] of cases) {
      const score = provisionalScore(song, { ...song, ...change })
      expect(score.isrcVerified).toBe(false)
      expect(score.evidence[0]).toBe(evidence)
      expect(score.confidence).toBeLessThanOrEqual(TEXT_ONLY_CAP)
    }
    const { durationMs: _durationMs, ...unknownLength } = song
    expect(provisionalScore(song, unknownLength).evidence[0]).toBe('isrc conflict (duration)')
  })

  it('reads titles without presentation noise, qualifiers or featured artists', () => {
    const score = provisionalScore(creep, {
      ...creep,
      title: 'Creep (feat. Someone) [Official Video]',
    })
    expect(score.evidence[0]).toBe('title 1.00')
  })

  it('costs a version tag on one side only by its strength', () => {
    const { durationMs: _durationMs, ...noDuration } = creep
    expect(provisionalScore(creep, { ...creep, title: 'Creep - Live' })).toMatchObject({
      confidence: 0.55,
      evidence: expect.arrayContaining(['version live']),
    })
    expect(provisionalScore(creep, { ...creep, live: true }).confidence).toBe(0.55)
    expect(provisionalScore({ ...creep, live: true }, { ...creep, live: true }).confidence).toBe(
      TEXT_ONLY_CAP,
    )
    const radioEdit = { ...creep, title: 'Creep (Radio Edit)', durationMs: 250_640 }
    expect(provisionalScore(creep, radioEdit)).toEqual({
      confidence: 0.64,
      evidence: ['title 1.00', 'artist 1.00', 'duration +12.0s', 'version radio edit'],
      isrcVerified: false,
    })
    expect(
      provisionalScore(noDuration, { ...noDuration, title: 'Creep - 2009 Remaster' }).confidence,
    ).toBe(TEXT_ONLY_CAP)
  })

  it('costs a duration more than 10 s or 20 s off', () => {
    expect(provisionalScore(creep, { ...creep, durationMs: 253_640 }).confidence).toBe(0.77)
    expect(provisionalScore(creep, { ...creep, durationMs: 263_640 }).confidence).toBe(0.48)
    expect(provisionalScore(creep, { ...creep, durationMs: 400_000 }).evidence).toContain(
      'duration +161.4s',
    )
  })

  it('caps a different title at 0.40 and an unknown artist at 0.45', () => {
    expect(
      provisionalScore(creep, { ...creep, title: 'Karma Police' }).confidence,
    ).toBeLessThanOrEqual(0.4)
    expect(provisionalScore(creep, { ...creep, artists: ['TLC'] }).confidence).toBe(0.45)
  })

  it('finds the main artist inside a combined credit', () => {
    const song: Comparable = { title: 'One Kiss', artists: ['Dua Lipa'], durationMs: 214_000 }
    const score = provisionalScore(song, { ...song, artists: ['Calvin Harris, Dua Lipa'] })
    expect(score.evidence[1]).toBe('artist 1.00')
    expect(provisionalScore({ ...song, artists: [] }, song).evidence[1]).toBe('artist 0.00')
  })

  it('reads version tags from the album on both sides, live ones as one family', () => {
    const dollParts: Comparable = {
      title: 'Doll Parts',
      artists: ['Hole'],
      album: 'Live Through This',
      durationMs: 210_000,
    }
    expect(provisionalScore(dollParts, dollParts).confidence).toBe(TEXT_ONLY_CAP)
    expect(provisionalScore(dollParts, { ...dollParts, album: 'Through This' })).toMatchObject({
      confidence: 0.55,
      evidence: expect.arrayContaining(['version live']),
    })
    const unplugged = { ...dollParts, album: 'MTV Unplugged in New York' }
    expect(provisionalScore(unplugged, { ...dollParts, album: 'x', live: true }).confidence).toBe(
      TEXT_ONLY_CAP,
    )
    expect(
      provisionalScore({ ...dollParts, album: 'Deluxe' }, { ...dollParts, album: '' }).evidence,
    ).toContain('version deluxe')
  })
})

describe('isLive', () => {
  it('reads the title’s qualifiers, the album and what the source says, not the title proper', () => {
    expect(isLive({ title: 'Song - Live', artists: [] })).toBe(true)
    expect(isLive({ title: 'Song', artists: [], album: 'Alive in Concert' })).toBe(true)
    expect(isLive({ title: 'Song', artists: [], live: true })).toBe(true)
    expect(isLive({ title: 'Live Forever', artists: [] })).toBe(false)
    expect(isLive({ title: 'Song', artists: [], album: 'Studio Album' })).toBe(false)
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
