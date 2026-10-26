import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import {
  artistKeyOf,
  artistKeysOf,
  artistRef,
  isSongIdentity,
  recSeedOf,
  seedArtistKey,
  seedKey,
  seedSongKeys,
  songIdentity,
  trackKeys,
} from './identity'
import { artist, spotify, ytm } from './test-fixtures'

describe('songIdentity, asked again', () => {
  it('gives the same answer, from the title and names alone', () => {
    const first = songIdentity('Copper Sun (Official Video)', ['Aurora Lane - Topic'])
    expect(first).toBe('song:aurora lane|copper sun')
    expect(songIdentity('Copper Sun (Official Video)', ['Aurora Lane - Topic'])).toBe(first)
    // Anything but a name counts as no artist, the first time or the next.
    expect(songIdentity('Copper Sun', [7, 'Aurora Lane'])).toBe('song:aurora lane|copper sun')
    expect(songIdentity('Copper Sun', [null, 'Aurora Lane'])).toBe('song:aurora lane|copper sun')
    expect(songIdentity('Copper Sun', [7])).toBeUndefined()
    expect(songIdentity('Copper Sun', [7])).toBeUndefined()
  })
})

describe('artistKeyOf', () => {
  it('keys an artist like the affinity does, without YouTube channel suffixes', () => {
    expect(artistKeyOf('Beyoncé')).toBe('beyonce')
    expect(artistKeyOf('Copper Sun - Topic')).toBe('copper sun')
    expect(artistKeyOf('CopperSunVEVO')).toBe('coppersun')
    expect(artistKeyOf('  Copper   Sun  ')).toBe('copper sun')
  })

  it('has no key for placeholders and non-names', () => {
    expect(artistKeyOf('Various Artists')).toBeUndefined()
    expect(artistKeyOf('')).toBeUndefined()
    expect(artistKeyOf(42)).toBeUndefined()
    expect(artistKeyOf(undefined)).toBeUndefined()
  })

  it('keeps a name that is only a suffix', () => {
    expect(artistKeyOf('VEVO')).toBe('vevo')
  })

  it('lists the keys of several names once each, in order', () => {
    expect(artistKeysOf(['B', 'a', 'A', 'Unknown Artist', 3])).toEqual(['b', 'a'])
  })
})

describe('songIdentity', () => {
  it('is the same for listings of one song across sources', () => {
    const youtube = songIdentity('Copper Sun (Official Video)', ['Aurora Lane'])
    expect(youtube).toBe('song:aurora lane|copper sun')
    expect(songIdentity('Copper Sun', ['Aurora Lane - Topic'])).toBe(youtube)
    expect(songIdentity('Aurora Lane - Copper Sun', ['Aurora Lane'])).toBe(youtube)
    expect(songIdentity('Copper Sun (feat. Basalt)', ['Aurora Lane', 'Basalt'])).toBe(youtube)
    expect(songIdentity('COPPER SUN!', ['aurora lane'])).toBe(youtube)
  })

  it('folds versions together', () => {
    expect(songIdentity('Copper Sun - Acoustic', ['Aurora Lane'])).toBe(
      songIdentity('Copper Sun', ['Aurora Lane']),
    )
  })

  it('keeps a dash title whose first part is not a credited artist', () => {
    expect(songIdentity('Night - Day', ['Aurora Lane'])).toBe('song:aurora lane|night day')
  })

  it('tells apart the same title by different artists', () => {
    expect(songIdentity('Copper Sun', ['Aurora Lane'])).not.toBe(
      songIdentity('Copper Sun', ['Basalt']),
    )
  })

  it('has none without a title or an artist', () => {
    expect(songIdentity('', ['Aurora Lane'])).toBeUndefined()
    expect(songIdentity('Copper Sun', [])).toBeUndefined()
    expect(songIdentity('Copper Sun', ['Various Artists'])).toBeUndefined()
    expect(songIdentity(undefined, ['Aurora Lane'])).toBeUndefined()
    expect(songIdentity('Copper Sun', 'Aurora Lane' as unknown as string[])).toBeUndefined()
  })

  it('never looks like an entity key', () => {
    const key = songIdentity('Copper Sun', ['Aurora Lane']) as string
    expect(isSongIdentity(key)).toBe(true)
    expect(isSongIdentity('youtube:track:abc')).toBe(false)
  })
})

describe('trackKeys', () => {
  it('knows a track by its entity key and its song identity', () => {
    expect(trackKeys(ytm('v1', 'Copper Sun', 'Aurora Lane'))).toEqual([
      'youtube:track:v1',
      'song:aurora lane|copper sun',
    ])
  })

  it('gives both YouTube prefixes one key', () => {
    const video = { ...ytm('v1', 'Copper Sun', 'Aurora Lane'), id: formatId('yt', 'track', 'v1') }
    expect(trackKeys(video)[0]).toBe('youtube:track:v1')
  })

  it('has no keys for a track without a valid ID', () => {
    expect(trackKeys({ ...ytm('v1', 'A', 'B'), id: 'nope' as never })).toEqual([])
  })
})

describe('seeds', () => {
  const track = ytm('v1', 'Copper Sun', ['Aurora Lane', 'Basalt'])

  it('records a radio seed the way the collector does', () => {
    expect(recSeedOf(track)).toEqual({
      type: 'track',
      id: track.id,
      name: 'Copper Sun',
      artists: ['Aurora Lane', 'Basalt'],
    })
    expect(recSeedOf(artist('Basalt'))).toEqual({ type: 'artist', name: 'Basalt' })
    expect(recSeedOf(artist('Basalt', 'UCb'))).toEqual({
      type: 'artist',
      id: 'ytm:artist:UCb',
      name: 'Basalt',
    })
  })

  it('keys a track seed by its track, else its song, and an artist seed by name', () => {
    expect(seedKey(recSeedOf(track))).toBe('track:youtube:track:v1')
    expect(seedKey({ type: 'track', name: 'Copper Sun', artists: ['Aurora Lane'] })).toBe(
      'track:song:aurora lane|copper sun',
    )
    expect(seedKey(recSeedOf(artist('Basalt - Topic')))).toBe('artist:basalt')
    expect(seedKey({ type: 'track', name: '' })).toBeUndefined()
    expect(seedKey({ type: 'other' } as never)).toBeUndefined()
  })

  it("knows a seed's own song, so radio never recommends it", () => {
    expect(seedSongKeys(recSeedOf(track))).toEqual([
      'youtube:track:v1',
      'song:aurora lane|copper sun',
    ])
    expect(seedSongKeys(recSeedOf(artist('Basalt')))).toEqual([])
  })

  it("names a seed's main artist", () => {
    expect(seedArtistKey(recSeedOf(track))).toBe('aurora lane')
    expect(seedArtistKey(recSeedOf(artist('Basalt')))).toBe('basalt')
    expect(seedArtistKey({ type: 'track', name: 'x' })).toBeUndefined()
  })

  it('makes artist references with an ID only when it is an artist ID', () => {
    expect(artistRef('Basalt', formatId('spotify', 'artist', 'abc'))).toEqual({
      id: 'spotify:artist:abc',
      name: 'Basalt',
    })
    expect(artistRef('Basalt', spotify('x', 'y', 'z').id)).toEqual({ name: 'Basalt' })
  })
})
