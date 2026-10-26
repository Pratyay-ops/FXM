import { describe, expect, it } from 'vitest'
import {
  isPolicyImageUrl,
  isSpotifyImageUrl,
  POLICY_IMAGE_HOSTS,
  SPOTIFY_IMAGE_HOSTS,
  shownArtwork,
  shownImageUrl,
} from './images'

/** The image hosts of the deployed `img-src` (scripts/build-dist/src/policies.ts). */
const DEPLOYED_IMG_SRC = [
  'https://*.ytimg.com',
  'https://*.googleusercontent.com',
  'https://*.ggpht.com',
  'https://*.scdn.co',
  'https://*.spotifycdn.com',
  'https://archive.org',
  'https://*.archive.org',
  'https://coverartarchive.org',
]

describe('Spotify’s images', () => {
  it('are those on its image hosts', () => {
    for (const url of [
      'https://i.scdn.co/image/ab67616d0000b273abcdef',
      'https://mosaic.scdn.co/640/ab67616d0000b273a',
      'https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84',
      'https://pickasso.spotifycdn.com/image/ab67c0de0000deef',
      'https://thisis-images.spotifycdn.com/37i9dQZF1DZ06evO05tE88-default.jpg',
    ]) {
      expect(isSpotifyImageUrl(url), url).toBe(true)
    }
    for (const url of [
      'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://scdn.co.example/image.jpg',
      'https://notscdn.co/image.jpg',
      'https://open.spotify.com/image.jpg',
      'not a url',
    ]) {
      expect(isSpotifyImageUrl(url), url).toBe(false)
    }
    expect(SPOTIFY_IMAGE_HOSTS).toEqual(['*.scdn.co', '*.spotifycdn.com'])
  })

  it('show only while Spotify is switched on; other images either way', () => {
    const spotify = 'https://i.scdn.co/image/ab67616d0000b273abcdef'
    const youtube = 'https://lh3.googleusercontent.com/abc=w544-h544'
    expect(shownImageUrl(spotify, true)).toBe(spotify)
    expect(shownImageUrl(spotify, false)).toBeUndefined()
    expect(shownImageUrl(youtube, false)).toBe(youtube)
    expect(shownImageUrl(undefined, true)).toBeUndefined()
    expect(shownImageUrl('', true)).toBeUndefined()
    const artwork = [{ url: spotify, width: 640 }, { url: youtube }]
    expect(shownArtwork(artwork, false)).toEqual([{ url: youtube }])
    expect(shownArtwork(artwork, true)).toEqual(artwork)
  })
})

describe('the policy’s images', () => {
  it('agree with the deployed img-src', () => {
    expect(POLICY_IMAGE_HOSTS.map((host) => `https://${host}`)).toEqual(DEPLOYED_IMG_SRC)
  })

  it('are the services’ image hosts, data: and blob: URLs and the app’s own', () => {
    for (const url of [
      'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://yt3.ggpht.com/abc=s120',
      'https://archive.org/services/img/nineinchnails_ghosts_I_IV',
      'https://ia800300.us.archive.org/1/items/x/cover.jpg',
      'https://coverartarchive.org/release/abc/front-250',
      'https://i.scdn.co/image/abc',
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:http://localhost:3000/9b1d2c3e',
      `${location.origin}/app/icons/icon-192.png`,
      '/app/icons/icon-192.png',
    ]) {
      expect(isPolicyImageUrl(url, false), url).toBe(true)
    }
  })

  it('leave out everything else: plugin hosts, HTTP, other ports, credentials', () => {
    for (const url of [
      'https://media.fxm-plugin.test/covers/al1.jpg',
      'https://ytimg.com/vi/abc/hqdefault.jpg',
      'http://i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://i.ytimg.com:8443/vi/abc/hqdefault.jpg',
      'https://user:pass@i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://archive.org.example/cover.jpg',
      'javascript:alert(1)',
      'https://[::1/',
    ]) {
      expect(isPolicyImageUrl(url, false), url).toBe(false)
      expect(shownImageUrl(url, true, false), url).toBeUndefined()
    }
  })

  it('take Jamendo’s only in a build that offers Jamendo', () => {
    const cover = 'https://usercontent.jamendo.com/?type=album&id=123&width=300'
    expect(isPolicyImageUrl(cover, true)).toBe(true)
    expect(isPolicyImageUrl(cover, false)).toBe(false)
  })
})
