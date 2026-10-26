import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TrackArtwork } from '../now-playing/track-artwork'
import { CoverArt as CatalogCoverArt } from '../search/catalog/cover-art'
import { appSources } from '../search/sources-context'
import { CoverArt } from './cover-art'

const SPOTIFY = 'https://i.scdn.co/image/ab67616d0000b273abcdef'
const MOSAIC = 'https://mosaic.scdn.co/640/ab67616d0000b273a'
const YOUTUBE = 'https://lh3.googleusercontent.com/abc=w544-h544'
/** A plugin's cover on a host of its own, which the app's img-src doesn't allow. */
const PLUGIN = 'https://media.fxm-plugin.test/covers/al1.jpg'

afterEach(() => {
  appSources.setSpotifyEnabled(true)
})

/** The image sources the rendered tree would request. */
function requested(container: HTMLElement): string[] {
  return [...container.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')
}

/** Every image component of the app, showing `url`. */
function allComponents(url: string) {
  return (
    <>
      <CoverArt src={url} seed="a" />
      <CatalogCoverArt artwork={[{ url, width: 640, height: 640 }]} seed="b" displayPx={160} />
      <TrackArtwork images={[{ url, width: 640, height: 640 }]} seed="c" size={48} />
    </>
  )
}

describe('the image components', () => {
  it('request no Spotify image while Spotify is switched off, and show the placeholder', () => {
    act(() => appSources.setSpotifyEnabled(false))
    const { container } = render(
      <>
        {allComponents(SPOTIFY)}
        {allComponents(MOSAIC)}
      </>,
    )
    expect(requested(container)).toEqual([])
    // Each still shows something: the seeded placeholder.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(6)
  })

  it('show Spotify’s images again once Spotify is switched on', () => {
    act(() => appSources.setSpotifyEnabled(false))
    const { container } = render(allComponents(SPOTIFY))
    expect(requested(container)).toEqual([])
    act(() => appSources.setSpotifyEnabled(true))
    expect(requested(container)).toEqual([SPOTIFY, SPOTIFY, SPOTIFY])
  })

  it('show other sources’ images whatever the switch says', () => {
    act(() => appSources.setSpotifyEnabled(false))
    const { container } = render(allComponents(YOUTUBE))
    expect(requested(container)).toEqual([YOUTUBE, YOUTUBE, YOUTUBE])
  })

  it('never request an image the app’s policy blocks, such as a plugin’s own host', () => {
    const { container } = render(allComponents(PLUGIN))
    expect(requested(container)).toEqual([])
  })
})
