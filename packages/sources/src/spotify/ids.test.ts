import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isSpotifyError } from './errors'
import {
  gidToSpotifyId,
  isSpotifyId,
  parseSpotifyLink,
  parseSpotifyUri,
  spotifyEntityIdFromLink,
  spotifyEntityIdFromUri,
  spotifyIdOf,
  spotifyIdToGid,
  spotifyUri,
} from './ids'

/** Pairs checked against Spotify itself: the gid spclient answered for each base62 ID. */
const PAIRS: Array<[base62: string, hex: string]> = [
  ['70LcF31zb1H0PyJoS1Sx1r', 'e666c6ccc4c7437f83552aa9bf4f2cfd'],
  ['4Z8W4fKeB5YxbusRsdQVPb', 'a3d4a9be89174457bdd11d2ebd9aaf39'],
]

describe('base62 IDs and gids', () => {
  for (const [base62, hex] of PAIRS) {
    it(`converts ${base62} to ${hex} and back`, () => {
      expect(spotifyIdToGid(base62)).toBe(hex)
      expect(gidToSpotifyId(hex)).toBe(base62)
      expect(gidToSpotifyId(hex.toUpperCase())).toBe(base62)
    })
  }

  it('keeps leading zeros on both sides', () => {
    expect(spotifyIdToGid('0000000000000000000001')).toBe('00000000000000000000000000000001')
    expect(gidToSpotifyId('00000000000000000000000000000000')).toBe('0000000000000000000000')
    expect(gidToSpotifyId('ffffffffffffffffffffffffffffffff')).toBe('7N42dgm5tFLK9N8MT7fHC7')
  })

  it('round-trips random 128-bit values', () => {
    for (let i = 0; i < 200; i++) {
      const hex = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join('')
      expect(spotifyIdToGid(gidToSpotifyId(hex))).toBe(hex)
    }
  })

  it('refuses malformed input', () => {
    expect(() => spotifyIdToGid('short')).toThrow(RangeError)
    expect(() => spotifyIdToGid('70LcF31zb1H0PyJoS1Sx1!')).toThrow(RangeError)
    // 22 base62 digits can exceed 128 bits; no Spotify ID does.
    expect(() => spotifyIdToGid('zzzzzzzzzzzzzzzzzzzzzz')).toThrow(RangeError)
    expect(() => gidToSpotifyId('e666')).toThrow(RangeError)
    expect(() => gidToSpotifyId('g666c6ccc4c7437f83552aa9bf4f2cfd')).toThrow(RangeError)
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
  const radio = { type: 'playlist', id: '37i9dQZF1E8OvD4G5pVGhr' }

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

  it('reads the playlist URIs of older clients', () => {
    expect(parseSpotifyUri('spotify:user:fixture.user:playlist:37i9dQZF1E8OvD4G5pVGhr')).toEqual(
      radio,
    )
    expect(parseSpotifyUri('spotify:user:fixture-user:playlist:nope')).toBeNull()
    expect(parseSpotifyUri('spotify:user:fixture-user:collection')).toBeNull()
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
    ).toEqual(radio)
    expect(parseSpotifyLink('https://example.com/track/70LcF31zb1H0PyJoS1Sx1r')).toBeNull()
    expect(parseSpotifyLink('https://open.spotify.com/track/nope')).toBeNull()
    expect(parseSpotifyLink(7)).toBeNull()
  })

  it('reads the playlist links of older clients as the playlist, not the user', () => {
    expect(
      parseSpotifyLink(
        'https://open.spotify.com/user/fixture-user/playlist/37i9dQZF1E8OvD4G5pVGhr?si=x',
      ),
    ).toEqual(radio)
    expect(
      parseSpotifyLink('http://play.spotify.com/user/fixture.user/playlist/37i9dQZF1E8OvD4G5pVGhr'),
    ).toEqual(radio)
    expect(parseSpotifyLink('spotify:user:fixture-user:playlist:37i9dQZF1E8OvD4G5pVGhr')).toEqual(
      radio,
    )
    expect(parseSpotifyLink('https://open.spotify.com/user/fixture-user')).toEqual({
      type: 'user',
      id: 'fixture-user',
    })
  })

  it('maps URIs to FXM IDs of the right kind only', () => {
    expect(spotifyEntityIdFromUri('track', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBe(
      'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
    )
    expect(spotifyEntityIdFromUri('album', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBeNull()
    expect(spotifyEntityIdFromUri('track', 'nonsense')).toBeNull()
    expect(spotifyUri('artist', '4Z8W4fKeB5YxbusRsdQVPb')).toBe(
      'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb',
    )
  })

  it('maps pasted links to FXM IDs', () => {
    expect(
      spotifyEntityIdFromLink('https://open.spotify.com/intl-fr/album/3gBVdu4a1MMJVMy6vwPEb8?si=1'),
    ).toBe('spotify:album:3gBVdu4a1MMJVMy6vwPEb8')
    expect(
      spotifyEntityIdFromLink(
        'https://open.spotify.com/user/fixture-user/playlist/37i9dQZF1E8OvD4G5pVGhr',
        'playlist',
      ),
    ).toBe('spotify:playlist:37i9dQZF1E8OvD4G5pVGhr')
    expect(spotifyEntityIdFromLink('spotify:artist:4Z8W4fKeB5YxbusRsdQVPb', 'track')).toBeNull()
    expect(spotifyEntityIdFromLink('https://open.spotify.com/user/fixture-user')).toBeNull()
    expect(spotifyEntityIdFromLink('https://open.spotify.com/episode/70LcF31zb1H0PyJoS1Sx1r')).toBe(
      null,
    )
    expect(spotifyEntityIdFromLink('radiohead creep')).toBeNull()
  })

  it('takes the base62 ID out of an FXM ID, refusing other sources and kinds', () => {
    const id = spotifyEntityIdFromUri('track', 'spotify:track:70LcF31zb1H0PyJoS1Sx1r')
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
