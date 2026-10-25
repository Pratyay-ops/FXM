import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYBACK_SETTINGS,
  isPlaybackBand,
  type MatchPlayFacts,
  mayPlayMatch,
  PLAYBACK_BANDS,
  sanitizePlaybackSettings,
} from './settings'

describe('playback settings', () => {
  it('start with everything off, frozen', () => {
    expect(DEFAULT_PLAYBACK_SETTINGS).toEqual({
      preferLossless: false,
      playBestGuesses: false,
      useInvidious: false,
    })
    expect(Object.isFrozen(DEFAULT_PLAYBACK_SETTINGS)).toBe(true)
  })

  it('keep valid stored values and drop unknown fields', () => {
    const stored = { preferLossless: true, playBestGuesses: true, useInvidious: true, extra: 1 }
    expect(sanitizePlaybackSettings(stored)).toEqual({
      preferLossless: true,
      playBestGuesses: true,
      useInvidious: true,
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'on'],
    ['an array', [true]],
    ['non-boolean fields', { preferLossless: 'yes', playBestGuesses: 1, useInvidious: null }],
  ])('fall back to the defaults for %s', (_label, value) => {
    expect(sanitizePlaybackSettings(value)).toEqual(DEFAULT_PLAYBACK_SETTINGS)
  })

  it('return a fresh, mutable object and never read inherited fields', () => {
    const settings = sanitizePlaybackSettings(undefined)
    settings.playBestGuesses = true
    expect(DEFAULT_PLAYBACK_SETTINGS.playBestGuesses).toBe(false)
    const inherited = Object.create({ preferLossless: true }) as object
    expect(sanitizePlaybackSettings(inherited).preferLossless).toBe(false)
  })
})

describe('playback bands', () => {
  it('lists the bands, most confident first', () => {
    expect(PLAYBACK_BANDS).toEqual(['auto', 'suggest', 'none'])
  })

  it.each([
    ['auto', true],
    ['suggest', true],
    ['none', true],
    ['Auto', false],
    ['toString', false],
    [undefined, false],
  ])('recognizes %s: %s', (value, expected) => {
    expect(isPlaybackBand(value)).toBe(expected)
  })
})

describe('mayPlayMatch', () => {
  const facts = (overrides: Partial<MatchPlayFacts>): MatchPlayFacts => ({
    target: 'song',
    band: 'suggest',
    isrcVerified: false,
    pinned: false,
    explicit: false,
    playBestGuesses: false,
    ...overrides,
  })

  it.each<[string, Partial<MatchPlayFacts>, boolean]>([
    ['an Auto song match', { band: 'auto' }, true],
    ['a Suggest guess reached by itself', {}, false],
    ['a Suggest guess the user asked for', { explicit: true }, true],
    ['a Suggest guess with "Play best guesses" on', { playBestGuesses: true }, true],
    ['a None match, even explicit', { band: 'none', explicit: true, playBestGuesses: true }, false],
    ['a pin, whatever its band', { band: 'none', pinned: true }, true],
    ['an Auto lossless match', { target: 'lossless', band: 'auto' }, true],
    ['an ISRC-verified lossless guess', { target: 'lossless', isrcVerified: true }, true],
    [
      'a lossless guess without an ISRC, even explicit',
      { target: 'lossless', explicit: true, playBestGuesses: true },
      false,
    ],
    [
      'a None lossless match with an ISRC',
      { target: 'lossless', band: 'none', isrcVerified: true },
      false,
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(mayPlayMatch(facts(overrides))).toBe(expected)
  })
})
