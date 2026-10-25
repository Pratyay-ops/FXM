import { describe, expect, it } from 'vitest'
import { artworkOf, LARGE_ARTWORK, musicThumbnailArtwork } from './artwork'

const cover = 'https://yt3.googleusercontent.com/abc'

describe('artwork', () => {
  it('lists the thumbnails smallest first, without repeats or bad URLs', () => {
    expect(
      artworkOf([
        { url: `${cover}=w544-h544-l90-rj`, width: 544, height: 544 },
        { url: `${cover}=w60-h60-l90-rj`, width: 60, height: 60 },
        { url: `${cover}=w60-h60-l90-rj`, width: 60, height: 60 },
        { url: 'javascript:alert(1)', width: 1, height: 1 },
        { width: 10 },
        'nope',
      ]),
    ).toEqual([
      { url: `${cover}=w60-h60-l90-rj`, width: 60, height: 60 },
      { url: `${cover}=w544-h544-l90-rj`, width: 544, height: 544 },
    ])
  })

  it('adds a large size of a small square Google image', () => {
    expect(
      artworkOf([{ url: `${cover}=w120-h120-l90-rj`, width: 120, height: 120 }]).at(-1),
    ).toEqual({
      url: `${cover}=w${LARGE_ARTWORK}-h${LARGE_ARTWORK}-l90-rj`,
      width: LARGE_ARTWORK,
      height: LARGE_ARTWORK,
    })
    const avatar = artworkOf([
      { url: '//yt3.ggpht.com/x=s88-c-k-c0x00ffffff-no-rj-mo', width: 88, height: 88 },
    ])
    expect(avatar.map((art) => art.url)).toEqual([
      'https://yt3.ggpht.com/x=s88-c-k-c0x00ffffff-no-rj-mo',
      `https://yt3.ggpht.com/x=s${LARGE_ARTWORK}-c-k-c0x00ffffff-no-rj-mo`,
    ])
  })

  it('leaves alone banners, video stills, large images and unsized URLs', () => {
    for (const thumbnails of [
      [{ url: 'https://lh3.googleusercontent.com/b=w540-h225-p-l90-rj', width: 540, height: 225 }],
      [{ url: 'https://i.ytimg.com/vi/XFkzRNyygfk/hqdefault.jpg', width: 120, height: 120 }],
      [{ url: `${cover}=w600-h600`, width: 600, height: 600 }],
      [{ url: cover, width: 120, height: 120 }],
      [{ url: `${cover}=w120-h120` }],
    ]) {
      expect(artworkOf(thumbnails)).toHaveLength(1)
    }
  })

  it('finds the thumbnails of the renderers that hold them', () => {
    const thumbnails = [{ url: `${cover}=w60-h60`, width: 60, height: 60 }]
    const renderer = { musicThumbnailRenderer: { thumbnail: { thumbnails } } }
    expect(musicThumbnailArtwork(renderer)).toHaveLength(2)
    expect(musicThumbnailArtwork({ thumbnailRenderer: renderer })).toHaveLength(2)
    expect(
      musicThumbnailArtwork({ croppedSquareThumbnailRenderer: { thumbnail: { thumbnails } } }),
    ).toHaveLength(2)
    expect(musicThumbnailArtwork({})).toEqual([])
  })
})
