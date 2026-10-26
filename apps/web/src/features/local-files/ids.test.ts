import { isEntityId, parseId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  fnv1a64,
  localAlbumId,
  localArtistId,
  localTrackId,
  newTrackNativeId,
  stableHash,
} from './ids'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('fnv1a64', () => {
  it.each([
    ['', 'cbf29ce484222325'],
    ['a', 'af63dc4c8601ec8c'],
    ['foobar', '85944171f73967e8'],
  ])('hashes %j like the reference implementation', (text, hash) => {
    expect(fnv1a64(bytes(text))).toBe(hash)
  })

  it('always gives 16 hex digits', () => {
    for (const text of ['x', 'Music/Artist/Album/01 Song.flac', '🎵'.repeat(50)]) {
      expect(fnv1a64(bytes(text))).toMatch(/^[0-9a-f]{16}$/)
    }
  })
})

describe('stableHash', () => {
  it('hashes composed and decomposed accents alike', () => {
    expect(stableHash('Beyoncé')).toBe(stableHash('Beyoncé'))
  })

  it('tells nearly equal paths apart', () => {
    const hashes = new Set(
      Array.from({ length: 2000 }, (_, index) => stableHash(`Music/Album/${index}.flac`)),
    )
    expect(hashes.size).toBe(2000)
  })
})

describe('newTrackNativeId', () => {
  it('depends on the root name and the path only', () => {
    expect(newTrackNativeId('Music', 'A/01.flac')).toBe(newTrackNativeId('Music', 'A/01.flac'))
    expect(newTrackNativeId('Music', 'A/01.flac')).not.toBe(newTrackNativeId('Other', 'A/01.flac'))
    expect(newTrackNativeId('Music', 'A/01.flac')).not.toBe(newTrackNativeId('Music', 'A/02.flac'))
  })

  it('never hands out an ID that is taken', () => {
    const first = newTrackNativeId('Music', 'A/01.flac')
    const second = newTrackNativeId('Music', 'A/01.flac', new Set([first]))
    expect(second).not.toBe(first)
    const third = newTrackNativeId('Music', 'A/01.flac', new Set([first, second]))
    expect(new Set([first, second, third]).size).toBe(3)
  })
})

describe('local IDs', () => {
  it('makes valid local track IDs', () => {
    const id = localTrackId(newTrackNativeId('Music', 'song.mp3'))
    expect(isEntityId(id, 'track')).toBe(true)
    expect(parseId(id).source).toBe('local')
  })

  it('groups albums and artists whatever the case, accents and spacing', () => {
    expect(localAlbumId('Björk', 'Homogenic')).toBe(localAlbumId('bjork ', ' HOMOGENIC'))
    expect(localAlbumId('Björk', 'Homogenic')).not.toBe(localAlbumId('Björk', 'Post'))
    expect(localArtistId('Sigur Rós')).toBe(localArtistId('sigur ros'))
    expect(parseId(localAlbumId('A', 'B')).kind).toBe('album')
    expect(parseId(localArtistId('A')).kind).toBe('artist')
  })
})
