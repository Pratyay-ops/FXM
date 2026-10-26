import { describe, expect, it } from 'vitest'
import { catalogTrackId, parseImportLink, youtubePlaylistId, youtubeTrackId } from './links'

describe('parseImportLink', () => {
  it('reads Spotify playlist, album and track links and URIs', () => {
    expect(
      parseImportLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'),
    ).toEqual({
      source: 'spotify',
      id: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    })
    expect(parseImportLink('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')).toEqual({
      source: 'spotify',
      id: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
    })
    expect(
      parseImportLink('https://open.spotify.com/intl-de/track/70LcF31zb1H0PyJoS1Sx1r'),
    ).toEqual({
      source: 'spotify',
      id: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
    })
    expect(
      parseImportLink('open.spotify.com/user/someone/playlist/37i9dQZF1DXcBWIGoYBM5M'),
    ).toEqual({
      source: 'spotify',
      id: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    })
  })

  it('reads YouTube and YouTube Music playlist links', () => {
    expect(
      parseImportLink(
        'https://music.youtube.com/playlist?list=OLAK5uy_kDbcd3l2c3Rb5mGcPyDq7qWl8q4bHn8eY',
      ),
    ).toEqual({
      source: 'youtube',
      id: 'ytm:playlist:OLAK5uy_kDbcd3l2c3Rb5mGcPyDq7qWl8q4bHn8eY',
    })
    expect(parseImportLink('youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijkl')).toEqual({
      source: 'youtube',
      id: 'yt:playlist:PLabcdefghijkl',
    })
  })

  it('refuses everything else', () => {
    for (const text of [
      'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/playlist?list=LL',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
      'https://example.com/playlist?list=PLabc',
      'not a link',
      '',
    ]) {
      expect(parseImportLink(text), text).toBeNull()
    }
  })
})

describe('youtubePlaylistId', () => {
  it('keeps YouTube Music’s curated playlists and strips the browse prefix', () => {
    expect(youtubePlaylistId('https://music.youtube.com/playlist?list=RDCLAK5uy_abcdefgh')).toBe(
      'ytm:playlist:RDCLAK5uy_abcdefgh',
    )
    expect(youtubePlaylistId('https://music.youtube.com/browse/VLPLabcdefgh')).toBe(
      'ytm:playlist:PLabcdefgh',
    )
    expect(youtubePlaylistId('https://www.youtube.com/playlist?list=WL')).toBeNull()
    expect(youtubePlaylistId('https://music.youtube.com/playlist?list=LM')).toBeNull()
  })
})

describe('youtubeTrackId', () => {
  it('reads every common video link form', () => {
    expect(youtubeTrackId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('yt:track:dQw4w9WgXcQ')
    expect(youtubeTrackId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('yt:track:dQw4w9WgXcQ')
    expect(youtubeTrackId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'yt:track:dQw4w9WgXcQ',
    )
    expect(youtubeTrackId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe(
      'ytm:track:dQw4w9WgXcQ',
    )
    expect(youtubeTrackId('https://www.youtube.com/watch?v=tooShort')).toBeNull()
    expect(youtubeTrackId('C:\\Music\\song.mp3')).toBeNull()
  })
})

describe('catalogTrackId', () => {
  it('names Spotify tracks and YouTube videos, and nothing else', () => {
    expect(catalogTrackId('spotify:track:70LcF31zb1H0PyJoS1Sx1r')).toBe(
      'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
    )
    expect(catalogTrackId('https://youtu.be/dQw4w9WgXcQ')).toBe('yt:track:dQw4w9WgXcQ')
    expect(catalogTrackId('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')).toBeNull()
    expect(catalogTrackId('/music/song.mp3')).toBeNull()
  })
})
