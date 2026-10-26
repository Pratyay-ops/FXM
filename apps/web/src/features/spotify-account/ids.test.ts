import { describe, expect, it } from 'vitest'
import {
  accountKeyOf,
  isAccountKey,
  isSpotifyCopyId,
  likedCopyId,
  playlistCopyId,
  spotifyTrackId,
  spotifyTrackIdOf,
} from './ids'

describe('copy IDs', () => {
  it('names a copy after what it copies', () => {
    expect(playlistCopyId('37i9dQZF1E8OvD4G5pVGhr')).toBe(
      'local:playlist:spotify-37i9dQZF1E8OvD4G5pVGhr',
    )
    expect(likedCopyId('abcdefghijklmnopqrstuv')).toBe(
      'local:playlist:spotify-liked-abcdefghijklmnopqrstuv',
    )
    expect(isSpotifyCopyId(playlistCopyId('37i9dQZF1E8OvD4G5pVGhr'))).toBe(true)
    expect(isSpotifyCopyId('local:playlist:4f0c2c6e-0000-4000-8000-000000000000')).toBe(false)
    expect(isSpotifyCopyId('spotify:playlist:37i9dQZF1E8OvD4G5pVGhr')).toBe(false)
  })

  it('refuses what is not a Spotify ID or an account key', () => {
    expect(() => playlistCopyId('../../etc')).toThrow(TypeError)
    expect(() => playlistCopyId('short')).toThrow(TypeError)
    // Real IDs are 128-bit numbers: 22 base62 digits can say more.
    expect(() => playlistCopyId('zzzzzzzzzzzzzzzzzzzzzz')).toThrow(TypeError)
    expect(() => likedCopyId('fixture-user')).toThrow(TypeError)
  })

  it("reads a Spotify track's base62 ID", () => {
    expect(spotifyTrackIdOf('spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBe('70LcF31zb1H0PyJoS1Sx1r')
    expect(spotifyTrackIdOf('ytm:track:dQw4w9WgXcQ')).toBeUndefined()
    expect(spotifyTrackIdOf('spotify:album:70LcF31zb1H0PyJoS1Sx1r')).toBeUndefined()
    expect(spotifyTrackId('70LcF31zb1H0PyJoS1Sx1r')).toBe('spotify:track:70LcF31zb1H0PyJoS1Sx1r')
  })
})

describe('accountKeyOf', () => {
  it('keys an account without keeping its user name', async () => {
    const key = await accountKeyOf('fixture-user')
    expect(isAccountKey(key)).toBe(true)
    expect(key).not.toContain('fixture')
    expect(await accountKeyOf('fixture-user')).toBe(key)
    expect(await accountKeyOf('another-user')).not.toBe(key)
  })
})
