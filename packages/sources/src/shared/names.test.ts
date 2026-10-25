import { describe, expect, it } from 'vitest'
import {
  artistSimilarity,
  cleanArtist,
  comparable,
  creditNames,
  lookupTitle,
  nameKey,
  readTitle,
  sameArtist,
  sameVersions,
  similarity,
} from './names'

describe('comparable and similarity', () => {
  it('compare names without case, accents or punctuation', () => {
    expect(comparable('Beyoncé & JAY-Z')).toBe('beyonce and jay z')
    expect(similarity(comparable('Taylor Swift'), comparable('taylorswift'))).toBe(1)
    expect(similarity('radiohead', 'radiohead tribute')).toBeCloseTo(0.696, 3)
    expect(similarity('', '')).toBe(0)
  })
})

describe('cleanArtist', () => {
  it('drops YouTube’s channel suffixes', () => {
    expect(cleanArtist('RadioheadVEVO')).toBe('Radiohead')
    expect(cleanArtist('Radiohead - Topic')).toBe('Radiohead')
    expect(cleanArtist('VEVO')).toBe('VEVO')
  })
})

describe('nameKey', () => {
  it('keeps a key for names of symbols only, which comparable leaves empty', () => {
    expect(nameKey('Radiohead')).toBe('radiohead')
    expect(comparable('!!!')).toBe('')
    expect(nameKey('!!!')).toBe('!!!')
    expect(nameKey('✝✝✝')).not.toBe(nameKey('!!!'))
    expect(nameKey('   ')).toBe('')
  })
})

describe('creditNames', () => {
  it('lists the whole credit and each name in it, comparable', () => {
    expect(creditNames('Daft Punk, Pharrell Williams & Nile Rodgers')).toEqual([
      'daft punk pharrell williams and nile rodgers',
      'daft punk',
      'pharrell williams',
      'nile rodgers',
    ])
    expect(creditNames('RadioheadVEVO')).toEqual(['radiohead'])
    expect(creditNames('!!!')).toEqual(['!!!'])
    expect(creditNames('   ')).toEqual([])
  })
})

describe('artistSimilarity and sameArtist', () => {
  it('match a credit that names the artist among others', () => {
    expect(artistSimilarity(['Daft Punk'], 'Daft Punk, Pharrell Williams & Nile Rodgers')).toBe(1)
    expect(artistSimilarity(['Radiohead'], 'Radiohead - Topic')).toBe(1)
    expect(sameArtist(['Daft Punk', 'Pharrell Williams'], 'Pharrell Williams')).toBe(true)
    expect(sameArtist(['!!!'], '!!!')).toBe(true)
  })

  it('tell other artists apart, tribute and karaoke acts included', () => {
    expect(artistSimilarity(['Radiohead'], 'Sunfly House Band')).toBeLessThan(0.6)
    expect(artistSimilarity(['Radiohead'], 'Thom Yorke')).toBeLessThan(0.6)
    expect(artistSimilarity([], 'Radiohead')).toBe(0)
    for (const credit of [
      'Radiohead Tribute',
      'Radiohead Karaoke',
      'Tribute to Radiohead',
      'Radiohead Experience',
    ]) {
      expect(sameArtist(['Radiohead'], credit)).toBe(false)
    }
    for (const credit of ['Amuse', 'Musey', 'The Muses']) {
      expect(sameArtist(['Muse'], credit)).toBe(false)
    }
    expect(sameArtist(['!!!'], '✝✝✝')).toBe(false)
  })
})

describe('readTitle and lookupTitle', () => {
  it('drop noise and the artist prefix, and read strong version tags', () => {
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

  it('keep a prefix that is not the artist', () => {
    expect(readTitle('Sonic Youth - Kool Thing', ['Radiohead']).clean).toBe(
      'Sonic Youth - Kool Thing',
    )
  })

  it('look a version up by its whole title, anything else by its title proper', () => {
    expect(lookupTitle(readTitle('Creep - Remastered 2009'))).toBe('Creep')
    expect(lookupTitle(readTitle("Love Story (Taylor's Version)"))).toBe(
      "Love Story (Taylor's Version)",
    )
    expect(lookupTitle(readTitle('Creep (Live)'))).toBe('Creep (Live)')
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
