import { describe, expect, it } from 'vitest'
import { artistKey, artistSimilarity, creditNames, readTitle, sameVersions, songKey } from './text'

describe('creditNames', () => {
  it('lists the whole credit and each name in it, comparable', () => {
    expect(creditNames('Daft Punk, Pharrell Williams & Nile Rodgers')).toEqual([
      'daft punk pharrell williams and nile rodgers',
      'daft punk',
      'pharrell williams',
      'nile rodgers',
    ])
    expect(creditNames('RadioheadVEVO')).toEqual(['radiohead'])
    expect(creditNames('   ')).toEqual([])
  })
})

describe('artistSimilarity', () => {
  it('matches a credit that names the artist among others', () => {
    expect(artistSimilarity(['Daft Punk'], 'Daft Punk, Pharrell Williams & Nile Rodgers')).toBe(1)
    expect(artistSimilarity(['Radiohead'], 'Radiohead - Topic')).toBe(1)
  })

  it('tells other artists apart', () => {
    expect(artistSimilarity(['Radiohead'], 'Sunfly House Band')).toBeLessThan(0.6)
    expect(artistSimilarity(['Radiohead'], 'Thom Yorke')).toBeLessThan(0.6)
    expect(artistSimilarity([], 'Radiohead')).toBe(0)
  })
})

describe('readTitle', () => {
  it('drops noise and the artist prefix, and reads strong version tags', () => {
    expect(readTitle('Radiohead - Creep (Official Music Video)', ['Radiohead'])).toEqual({
      clean: 'Creep',
      core: 'Creep',
      versions: [],
    })
    expect(readTitle('Creep (Acoustic)', ['Radiohead'])).toMatchObject({
      core: 'Creep',
      versions: ['acoustic'],
    })
    expect(
      readTitle('Get Lucky (feat. Pharrell Williams & Nile Rodgers) [Daft Punk Remix]'),
    ).toMatchObject({
      core: 'Get Lucky',
      versions: ['remix'],
    })
  })

  it('keeps a prefix that is not the artist', () => {
    expect(readTitle('Sonic Youth - Kool Thing', ['Radiohead']).clean).toBe(
      'Sonic Youth - Kool Thing',
    )
  })
})

describe('sameVersions', () => {
  it('compares sorted tag lists', () => {
    expect(sameVersions([], [])).toBe(true)
    expect(sameVersions(['live'], ['live'])).toBe(true)
    expect(sameVersions(['live'], [])).toBe(false)
    expect(sameVersions(['live'], ['remix'])).toBe(false)
  })
})

describe('songKey and artistKey', () => {
  it('give listings of the same song or artist one key', () => {
    expect(songKey('Radiohead', 'Creep')).toBe('radiohead|creep')
    expect(songKey('RadioheadVEVO', 'Radiohead - Creep (Official Music Video)')).toBe(
      'radiohead|creep',
    )
    expect(songKey('Blur', 'Song 2 - 2012 Remaster')).toBe(songKey('Blur', 'Song 2'))
    expect(artistKey('Björk')).toBe('bjork')
    expect(artistKey('Radiohead - Topic')).toBe(artistKey('radiohead'))
  })
})
