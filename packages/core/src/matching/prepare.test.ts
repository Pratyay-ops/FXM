import { describe, expect, it } from 'vitest'
import {
  artistSimilarity,
  cleanArtistName,
  isClassicalTitle,
  isCredited,
  prepareTitle,
  sameArtist,
  splitArtistNames,
  stripArtistPrefix,
} from './prepare'

describe('cleanArtistName and splitArtistNames', () => {
  it('drops channel decorations and bracketed parts', () => {
    expect(cleanArtistName('Bill Haley & His Comets - Topic')).toBe('bill haley & his comets')
    expect(cleanArtistName('TheWeekndVEVO')).toBe('theweeknd')
    expect(cleanArtistName('Radiohead VEVO')).toBe('radiohead')
    expect(cleanArtistName('BLACKPINK Official')).toBe('blackpink')
    expect(cleanArtistName('Tama Kurogane (CV: Akina)')).toBe('tama kurogane')
    expect(cleanArtistName('BTS (방탄소년단)')).toBe('bts')
  })

  it('splits a credit into its names', () => {
    expect(splitArtistNames('Luis Fonsi & Daddy Yankee')).toEqual(['luis fonsi', 'daddy yankee'])
    expect(splitArtistNames('A, B and C x D feat. E')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitArtistNames('Lana Del Rey vs. Cedric Gervais')).toEqual([
      'lana del rey',
      'cedric gervais',
    ])
    expect(splitArtistNames('Yo-Yo Ma')).toEqual(['yo-yo ma'])
    expect(splitArtistNames('Lil Nas X')).toEqual(['lil nas x'])
  })
})

describe('sameArtist', () => {
  it('matches equal names, a leading "The" aside, and close spellings', () => {
    expect(sameArtist('the everly brothers', 'everly brothers')).toBe(true)
    expect(sameArtist('everly brothers', 'every brothers')).toBe(true)
    expect(sameArtist('kate bush', 'katebush')).toBe(true)
  })

  it('finds a name of two words or more inside a longer one, one way only', () => {
    expect(sameArtist('jeff buckley', 'jeff buckley music official channel')).toBe(true)
    expect(sameArtist('jeff buckley music official channel', 'jeff buckley')).toBe(false)
    expect(sameArtist('bill haley & his comets', 'bill haley')).toBe(false)
    expect(sameArtist('queen', 'queen naija')).toBe(false)
  })

  it('never matches an empty name', () => {
    expect(sameArtist('', 'radiohead')).toBe(false)
    expect(sameArtist('radiohead', '')).toBe(false)
  })
})

describe('artistSimilarity', () => {
  it('is the share of the source artists found among the candidate names', () => {
    expect(artistSimilarity(['Luis Fonsi', 'Daddy Yankee'], ['Luis Fonsi', 'Daddy Yankee'])).toBe(1)
    expect(artistSimilarity(['Luis Fonsi', 'Daddy Yankee'], ['Luis Fonsi & Daddy Yankee'])).toBe(1)
    expect(artistSimilarity(['Luis Fonsi', 'Daddy Yankee'], ['Luis Fonsi'])).toBe(0.5)
    expect(artistSimilarity(['Radiohead'], ['Lena Hall'])).toBe(0)
  })

  it('counts a joined credit by the share of its names', () => {
    expect(artistSimilarity(['Bill Haley & His Comets'], ['Bill Haley'])).toBe(0.5)
    expect(artistSimilarity(['Bill Haley & His Comets'], ['Bill Haley and His Comets'])).toBe(1)
  })

  it('reads channels without their decorations', () => {
    expect(artistSimilarity(['Lomelda'], ['Lomelda - Topic'])).toBe(1)
    expect(artistSimilarity(['The Weeknd'], ['TheWeekndVEVO'])).toBe(1)
  })

  it('is 0 without names on either side', () => {
    expect(artistSimilarity([], ['Radiohead'])).toBe(0)
    expect(artistSimilarity(['Radiohead'], [])).toBe(0)
    expect(artistSimilarity([' '], ['Radiohead'])).toBe(0)
  })
})

describe('isCredited', () => {
  it('finds a featured artist among the credits, whole or name by name', () => {
    expect(isCredited('Pharrell Williams', ['Daft Punk', 'Pharrell Williams'])).toBe(true)
    expect(isCredited('Sia & Diplo', ['LSD', 'Sia', 'Diplo'])).toBe(true)
    expect(isCredited('Justin Bieber', ['Luis Fonsi', 'Daddy Yankee'])).toBe(false)
    expect(isCredited('', ['Luis Fonsi'])).toBe(false)
  })
})

describe('stripArtistPrefix', () => {
  it('removes a leading credit of known artists before a dash', () => {
    expect(stripArtistPrefix('the weeknd - blinding lights', ['The Weeknd'])).toBe(
      'blinding lights',
    )
    expect(stripArtistPrefix('luis fonsi, daddy yankee - despacito', ['Luis Fonsi'])).toBe(
      'luis fonsi, daddy yankee - despacito',
    )
    expect(
      stripArtistPrefix('luis fonsi, daddy yankee - despacito', ['Luis Fonsi', 'Daddy Yankee']),
    ).toBe('despacito')
  })

  it('takes a title quoted after the artist, and what follows as a qualifier', () => {
    expect(stripArtistPrefix('yoasobi「アイドル」', ['YOASOBI'])).toBe('アイドル')
    expect(stripArtistPrefix("bts (방탄소년단) 'dynamite'", ['BTS'])).toBe('dynamite')
    expect(stripArtistPrefix('artist "song" remix', ['Artist'])).toBe('song (remix)')
    expect(stripArtistPrefix('artist『song』live', ['Artist'])).toBe('song (live)')
  })

  it('keeps titles that do not start with a known artist', () => {
    expect(stripArtistPrefix('depeche mode - stripped', ['Radiohead'])).toBe(
      'depeche mode - stripped',
    )
    expect(stripArtistPrefix("rock'n'roll queen", ['Queen'])).toBe("rock'n'roll queen")
    expect(stripArtistPrefix('stripped', [])).toBe('stripped')
    expect(stripArtistPrefix("artist ''", ['Artist'])).toBe("artist ''")
  })
})

describe('prepareTitle', () => {
  it('normalizes and splits the title proper from its qualifiers and featured artists', () => {
    const prepared = prepareTitle('Despacito (Remix) (feat. Justin Bieber)', ['Luis Fonsi'])
    expect(prepared.core).toBe('despacito')
    expect(prepared.qualifiers).toEqual(['remix'])
    expect(prepared.featured).toEqual(['justin bieber'])
    expect([...prepared.versions]).toEqual([['remix', 'strong']])
  })

  it('strips presentation noise and the artist prefix first', () => {
    const prepared = prepareTitle('The Weeknd - Blinding Lights (Official Video)', ['The Weeknd'])
    expect(prepared.core).toBe('blinding lights')
    expect(prepared.versions.size).toBe(0)
    expect(prepareTitle('Depeche Mode - Stripped', ['Depeche Mode']).core).toBe('stripped')
  })

  it('takes version tags from qualifiers and the album, never from the title proper', () => {
    expect(prepareTitle('Live Forever', ['Oasis']).versions.size).toBe(0)
    const unplugged = prepareTitle('About a Girl', ['Nirvana'], 'MTV Unplugged in New York')
    expect([...unplugged.versions]).toEqual([['live', 'strong']])
    const live = prepareTitle('About A Girl (Live)', ['Nirvana'], 'MTV Unplugged In New York')
    expect([...live.versions]).toEqual([['live', 'strong']])
  })

  it('groups tags into families and keeps the strongest level', () => {
    const remaster = prepareTitle('Hotel California - 2013 Remaster', [], 'Hotel California')
    expect([...remaster.versions]).toEqual([['remaster', 'soft']])
    const edits = prepareTitle('Song (Radio Edit) [Single Version]', [])
    expect([...edits.versions]).toEqual([['edit', 'medium']])
    const takes = prepareTitle('Song (Take 3)', [])
    expect([...takes.versions]).toEqual([['demo', 'strong']])
    const telugu = prepareTitle('Srivalli (Telugu)', [])
    expect([...telugu.versions]).toEqual([['telugu version', 'strong']])
    expect([...prepareTitle('Song (Sped Up)', []).versions]).toEqual([['sped up', 'strong']])
    expect([...prepareTitle('Song (Slowed + Reverb)', []).versions]).toEqual([['slowed', 'strong']])
  })

  it('names the remixer of a remix', () => {
    const cg = prepareTitle(
      'Summertime Sadness (Lana Del Rey Vs. Cedric Gervais) (Cedric Gervais Remix)',
      ['Lana Del Rey'],
    )
    expect(cg.core).toBe('summertime sadness')
    expect(cg.remixDetail).toBe('cedric gervais')
    expect(prepareTitle('Song (Remix)', []).remixDetail).toBe('')
    expect(prepareTitle('Song (Live)', []).remixDetail).toBe('')
  })
})

describe('isClassicalTitle', () => {
  it.each([
    'Unaccompanied Cello Suite No. 1 in G major, BWV 1007: I. Prélude',
    'Piano Sonata No. 14 in C-sharp minor, Op. 27 No. 2',
    'Symphony No. 5',
    'Eine kleine Nachtmusik, K. 525',
    'Goldberg Variations, BWV 988: Aria',
    'Requiem in D minor',
  ])('reads %j as classical', (title) => {
    expect(isClassicalTitle(title)).toBe(true)
  })

  it.each(['Blinding Lights', 'Top 40', 'Hop 2 It', 'Hotel California'])(
    'reads %j as popular',
    (title) => {
      expect(isClassicalTitle(title)).toBe(false)
    },
  )
})
