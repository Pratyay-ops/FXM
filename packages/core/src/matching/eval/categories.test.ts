import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_PERCENT,
  caseCategories,
  categoriesOfInput,
  splitOf,
  stableHash,
} from './categories'
import { group, item, label, source } from './testing'
import { casesOf } from './types'

describe('splitOf', () => {
  it('is stable and sends about 30 % of groups to calibration', () => {
    expect(splitOf('sp:0tW2gwaRzFQQrgr2UCO56G')).toBe(splitOf('sp:0tW2gwaRzFQQrgr2UCO56G'))
    const ids = Array.from({ length: 2000 }, (_, index) => `sp:track-${index}`)
    const calibration = ids.filter((id) => splitOf(id) === 'calibration').length
    expect(calibration / ids.length).toBeGreaterThan(CALIBRATION_PERCENT / 100 - 0.04)
    expect(calibration / ids.length).toBeLessThan(CALIBRATION_PERCENT / 100 + 0.04)
  })

  it('hashes like FNV-1a', () => {
    expect(stableHash('')).toBe(0x811c9dc5)
    expect(stableHash('a')).toBe(0xe40c292c)
  })
})

describe('categoriesOfInput', () => {
  it('reads popularity: mainstream from 50, long tail up to 30', () => {
    expect(categoriesOfInput({ title: 'Song', artists: ['A'], popularity: 80 })).toEqual([
      'mainstream',
    ])
    expect(categoriesOfInput({ title: 'Song', artists: ['A'], popularity: 12 })).toEqual([
      'long-tail',
    ])
    expect(categoriesOfInput({ title: 'Song', artists: ['A'], popularity: 40 })).toEqual([])
    expect(
      categoriesOfInput({
        title: 'Song',
        artists: ['A'],
        popularity: 70,
        sourceCategories: ['long-tail'],
      }),
    ).toEqual(['mainstream'])
  })

  it('finds classical works, Spotify Singles, re-recordings and compilations', () => {
    expect(
      categoriesOfInput({
        title: 'Cello Suite No. 1 in G Major, BWV 1007: I. Prélude',
        artists: ['Johann Sebastian Bach', 'Yo-Yo Ma'],
        popularity: 70,
      }),
    ).toEqual(['classical'])
    expect(
      categoriesOfInput({
        title: 'Challa - Spotify Singles',
        artists: ['Gurdas Maan'],
        popularity: 58,
      }),
    ).toEqual(['spotify-singles'])
    expect(
      categoriesOfInput({
        title: "Love Story (Taylor's Version)",
        artists: ['Taylor Swift'],
        popularity: 79,
      }),
    ).toEqual(['mainstream', 're-recording'])
    expect(
      categoriesOfInput({
        title: 'Song',
        artists: ['A'],
        album: 'Greatest Hits',
        albumType: 'album',
      }),
    ).toEqual(['compilation'])
    expect(categoriesOfInput({ title: 'Song', artists: ['A'], albumType: 'compilation' })).toEqual([
      'compilation',
    ])
  })

  it('marks non-Latin titles and artists as regional and cross-script', () => {
    expect(categoriesOfInput({ title: 'しわあわせ', artists: ['Vaundy'], popularity: 74 })).toEqual(
      ['mainstream', 'regional', 'cross-script'],
    )
    expect(
      categoriesOfInput({ title: 'Song', artists: ['A'], sourceCategories: ['regional'] }),
    ).toEqual(['regional'])
  })
})

describe('caseCategories', () => {
  const base = group({
    categories: ['mainstream'],
    variants: [
      { slice: 'spotify', source: source('Idol', 'YOASOBI', 213, { isrc: 'JPU902300341' }) },
      { slice: 'data-export', source: source('Idol', 'YOASOBI', undefined) },
      { slice: 'musicbrainz-exact', source: source('Idol', 'YOASOBI', 213) },
    ],
    items: { a: item('アイドル', 'YOASOBI', 213), b: item('Other', 'Somebody', 100) },
    pages: { 'isrc-songs/1/JPU902300341': { items: ['b', 'a'] } },
    labels: { a: label('exact'), b: label('wrong') },
  })
  const [spotify, dataExport, musicBrainz] = casesOf([base])

  it('adds cross-script and ISRC squatter from the labels to primary inputs', () => {
    expect(spotify && caseCategories(spotify)).toEqual([
      'mainstream',
      'cross-script',
      'isrc-squatter',
    ])
  })

  it('keeps data-export rows apart, and MusicBrainz inputs out of the categories', () => {
    expect(dataExport && caseCategories(dataExport)).toEqual(['data-export'])
    expect(musicBrainz && caseCategories(musicBrainz)).toEqual([])
  })
})
