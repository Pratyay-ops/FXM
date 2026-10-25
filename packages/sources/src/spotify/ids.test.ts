import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isSpotifyError } from './errors'
import {
  base62ToHex,
  entityIdFromUri,
  hexToBase62,
  isSpotifyId,
  parseSpotifyLink,
  parseSpotifyUri,
  spotifyIdOf,
  spotifyUri,
} from './ids'

/** Pairs checked against Spotify itself: the gid spclient answered for each base62 ID. */
const PAIRS: Array<[base62: string, hex: string]> = [
  ['70LcF31zb1H0PyJoS1Sx1r', 'e666c6ccc4c7437f83552aa9bf4f2cfd'],
  ['4Z8W4fKeB5YxbusRsdQVPb', 'a3d4a9be89174457bdd11d2ebd9aaf39'],
]

describe('base62 and hex', () => {
  for (const [base62, hex] of PAIRS) {
    it(`converts ${base62} to ${hex} and back`, () => {
      expect(base62ToHex(base62)).toBe(hex)
      expect(hexToBase62(hex)).toBe(base62)
      expect(hexToBase62(hex.toUpperCase())).toBe(base62)
    })
  }

  it('keeps leading zeros on both sides', () => {
    expect(base62ToHex('0000000000000000000001')).toBe('00000000000000000000000000000001')
    expect(hexToBase62('00000000000000000000000000000000')).toBe('0000000000000000000000')
    expect(hexToBase62('ffffffffffffffffffffffffffffffff')).toBe('7N42dgm5tFLK9N8MT7fHC7')
  })

  it('round-trips random 128-bit values', () => {
    for (let i = 0; i < 200; i++) {
      const hex = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join('')
      expect(base62ToHex(hexToBase62(hex))).toBe(hex)
    }
  })

  it('refuses malformed input', () => {
    expect(() => base62ToHex('short')).toThrow(RangeError)
    expect(() => base62ToHex('70LcF31zb1H0PyJoS1Sx1!')).toThrow(RangeError)
    // 22 base62 digits can exceed 128 bits; no Spotify ID does.
    expect(() => base62ToHex('zzzzzzzzzzzzzzzzzzzzzz')).toThrow(RangeError)
    expect(() => hexToBase62('e666')).toThrow(RangeError)
    expect(() => hexToBase62('g666c6ccc4c7437f83552aa9bf4f2cfd')).toThrow(RangeError)
  })

  it('tells IDs from other strings', () => {
    expect(isSpotifyId('70LcF31zb1H0PyJoS1Sx1r')).toBe(true)
    expect(isSpotifyId('7N42dgm5tFLK9N8MT7fHC7')).toBe(true)
    expect(isSpotifyId('7N42dgm5tFLK9N8MT7fHC8')).toBe(false)
    expect(isSpotifyId(42)).toBe(false)
    expect(isSpotifyId(undefined)).toBe(false)
  })
})

describe('URIs and links', () => {
  it('parses catalog URIs and refuses malformed ones', () => {
    expect(parseSpotifyUri('spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toEqual({
      type: 'track',
      id: '70LcF31zb1H0PyJoS1Sx1r',
    })
    expect(parseSpotifyUri('spotify:user:fixture-user')).toEqual({
      type: 'user',
      id: 'fixture-user',
    })
    expect(parseSpotifyUri('spotify:track:short')).toBeNull()
    expect(parseSpotifyUri('spotify:track')).toBeNull()
    expect(parseSpotifyUri('ytm:track:dQw4w9WgXcQ')).toBeNull()
    expect(parseSpotifyUri(null)).toBeNull()
  })

  it('reads the links users paste', () => {
    const creep = { type: 'track', id: '70LcF31zb1H0PyJoS1Sx1r' }
    expect(parseSpotifyLink('https://open.spotify.com/track/70LcF31zb1H0PyJoS1Sx1r')).toEqual(creep)
    expect(
      parseSpotifyLink('https://open.spotify.com/intl-de/track/70LcF31zb1H0PyJoS1Sx1r?si=abc'),
    ).toEqual(creep)
    expect(
      parseSpotifyLink(' https://open.spotify.com/embed/track/70LcF31zb1H0PyJoS1Sx1r '),
    ).toEqual(creep)
    expect(parseSpotifyLink('spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toEqual(creep)
    expect(
      parseSpotifyLink('https://open.spotify.com/playlist/37i9dQZF1E8OvD4G5pVGhr#top'),
    ).toEqual({ type: 'playlist', id: '37i9dQZF1E8OvD4G5pVGhr' })
    expect(parseSpotifyLink('https://example.com/track/70LcF31zb1H0PyJoS1Sx1r')).toBeNull()
    expect(parseSpotifyLink('https://open.spotify.com/track/nope')).toBeNull()
    expect(parseSpotifyLink(7)).toBeNull()
  })

  it('maps URIs to FXM IDs of the right kind only', () => {
    expect(entityIdFromUri('track', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBe(
      'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
    )
    expect(entityIdFromUri('album', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBeUndefined()
    expect(entityIdFromUri('track', 'nonsense')).toBeUndefined()
    expect(spotifyUri('artist', '4Z8W4fKeB5YxbusRsdQVPb')).toBe(
      'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb',
    )
  })

  it('takes the base62 ID out of an FXM ID, refusing other sources and kinds', () => {
    const id = entityIdFromUri('track', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')
    if (!id) throw new Error('expected an ID')
    expect(spotifyIdOf(id, 'track')).toBe('70LcF31zb1H0PyJoS1Sx1r')
    const foreign = 'ytm:track:dQw4w9WgXcQ' as typeof id
    let error: unknown
    try {
      spotifyIdOf(foreign, 'track')
    } catch (e) {
      error = e
    }
    expect(isSpotifyError(error, 'foreign-id')).toBe(true)
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect(() => spotifyIdOf('spotify:track:bad' as typeof id, 'track')).toThrow(/Malformed/u)
  })
})
