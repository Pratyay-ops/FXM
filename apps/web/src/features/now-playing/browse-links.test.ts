import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { entityPath, searchPath } from './browse-links'

describe('entityPath', () => {
  it('links the pages each source has, with the pages’ own link helpers', () => {
    expect(entityPath(formatId('ytm', 'album', 'MPREb_abc'))).toBe('/album/ytm:MPREb_abc')
    expect(entityPath(formatId('ytm', 'artist', 'UCabc'))).toBe('/artist/ytm:UCabc')
    expect(entityPath(formatId('spotify', 'playlist', '37i9'))).toBe('/playlist/spotify:37i9')
    // An Internet Archive item is an album; its native ID keeps its slash, encoded.
    expect(entityPath(formatId('archive', 'album', 'item/disc'))).toBe('/album/archive:item%2Fdisc')
    // The library's own playlists open their page in the library.
    expect(entityPath(formatId('local', 'playlist', 'abc'))).toBe('/playlist/local:playlist:abc')
  })

  it('names the rest as plain text: pages their source doesn’t have', () => {
    expect(entityPath(formatId('archive', 'artist', 'someone'))).toBeUndefined()
    expect(entityPath(formatId('jamendo', 'playlist', '42'))).toBeUndefined()
  })

  it('searches for a query', () => {
    expect(searchPath(' daft punk ')).toBe('/search?q=daft+punk')
  })
})
