import { describe, expect, it } from 'vitest'
import { detectSeparator, nameFromFileName, parseCsv, parseCsvImport, splitArtistList } from './csv'
import { isImportInputError } from './errors'

/** Exportify's header, as its English translation file spells the columns (see CLEAN-ROOM.md). */
const EXPORTIFY_HEADER =
  '"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album URI","Album Name","Album Artist URI(s)","Album Artist Name(s)","Album Release Date","Album Image URL","Disc Number","Track Number","Track Duration (ms)","Track Preview URL","Explicit","Popularity","ISRC","Added By","Added At"'

/** One Exportify row; the values are constructed for this test. */
function exportifyRow(fields: {
  uri: string
  name: string
  artists: string
  album: string
  date: string
  ms: number
  explicit?: boolean
  isrc?: string
  added?: string
}): string {
  return [
    fields.uri,
    fields.name,
    'spotify:artist:xxxxxxxxxxxxxxxxxxxxxx',
    fields.artists,
    'spotify:album:xxxxxxxxxxxxxxxxxxxxxx',
    fields.album,
    '',
    fields.artists,
    fields.date,
    '',
    '1',
    '1',
    String(fields.ms),
    '',
    String(fields.explicit ?? false),
    '50',
    fields.isrc ?? '',
    'spotify:user:someone',
    fields.added ?? '2024-01-02T03:04:05Z',
  ]
    .map((value) => `"${value.replaceAll('"', '""')}"`)
    .join(',')
}

describe('parseCsv', () => {
  it('splits quoted fields with separators, doubled quotes and line breaks', () => {
    const text = 'a,"b, c","say ""hi""","two\nlines"\r\n1,2,3,4\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['1', '2', '3', '4'],
    ])
  })

  it('drops a byte-order mark and empty lines, and keeps empty fields', () => {
    expect(parseCsv('\ufeffx,y\n\n,\r\n\nlast,')).toEqual([
      ['x', 'y'],
      ['', ''],
      ['last', ''],
    ])
  })

  it('reads a last line without a line break, and CR-only line ends', () => {
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('detects semicolons and tabs as separators', () => {
    expect(detectSeparator('Title;Artist;"A, B"\n')).toBe(';')
    expect(detectSeparator('Title\tArtist\n')).toBe('\t')
    expect(detectSeparator('Title')).toBe(',')
    expect(parseCsv('Title;Artist\nOne;Two')).toEqual([
      ['Title', 'Artist'],
      ['One', 'Two'],
    ])
  })
})

describe('splitArtistList', () => {
  it('splits Exportify’s list and unescapes commas inside names', () => {
    expect(splitArtistList('Tyler\\, The Creator, Kali Uchis')).toEqual([
      'Tyler, The Creator',
      'Kali Uchis',
    ])
    expect(splitArtistList('Daft Punk,Pharrell Williams;Nile Rodgers')).toEqual([
      'Daft Punk',
      'Pharrell Williams',
      'Nile Rodgers',
    ])
    expect(splitArtistList(' , ')).toEqual([])
  })
})

describe('parseCsvImport', () => {
  it('reads Exportify’s columns into rows with Spotify tracks, ISRCs and lengths', () => {
    const text = [
      EXPORTIFY_HEADER,
      exportifyRow({
        uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
        name: 'Creep',
        artists: 'Radiohead',
        album: 'Pablo Honey',
        date: '1993-02-22',
        ms: 238_640,
        isrc: 'GBAYE9200070',
        added: '2024-05-06T07:08:09Z',
      }),
      exportifyRow({
        uri: 'spotify:track:0000000000000000000002',
        name: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
        artists: 'Daft Punk, Pharrell Williams, Nile Rodgers',
        album: 'Random Access Memories',
        date: '2013',
        ms: 369_626,
        explicit: true,
      }),
    ].join('\n')
    const parsed = parseCsvImport(text, 'road_trip.csv')
    expect(parsed.kind).toBe('csv')
    expect(parsed.label).toBe('road_trip.csv')
    expect(parsed.collections).toHaveLength(1)
    const [collection] = parsed.collections
    expect(collection?.name).toBe('road trip')
    expect(collection?.rows).toEqual([
      {
        title: 'Creep',
        artists: ['Radiohead'],
        trackId: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
        album: 'Pablo Honey',
        durationMs: 238_640,
        isrc: 'GBAYE9200070',
        explicit: false,
        releaseDate: '1993-02-22',
        addedAt: Date.parse('2024-05-06T07:08:09Z'),
      },
      {
        title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
        artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
        trackId: 'spotify:track:0000000000000000000002',
        album: 'Random Access Memories',
        durationMs: 369_626,
        explicit: true,
        releaseDate: '2013',
        addedAt: Date.parse('2024-01-02T03:04:05Z'),
      },
    ])
  })

  it('reads other exporters’ columns: plain artist, m:ss lengths, links and a label', () => {
    const text = [
      'Title,Artist,Album,Duration,Record Label,Spotify URL',
      'Song A,Simon & Garfunkel,Bookends,3:05,Columbia,https://open.spotify.com/intl-de/track/0000000000000000000003?si=x',
      '"Song B",Band; Guest,,245,,https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    ].join('\n')
    const rows = parseCsvImport(text).collections[0]?.rows
    expect(rows?.[0]).toMatchObject({
      title: 'Song A',
      artists: ['Simon & Garfunkel'],
      album: 'Bookends',
      durationMs: 185_000,
      label: 'Columbia',
      trackId: 'spotify:track:0000000000000000000003',
    })
    expect(rows?.[1]).toMatchObject({
      title: 'Song B',
      artists: ['Band', 'Guest'],
      durationMs: 245_000,
      trackId: 'ytm:track:dQw4w9WgXcQ',
    })
    expect(rows?.[1]).not.toHaveProperty('album')
  })

  it('splits rows into playlists by a playlist column', () => {
    const text = 'Playlist name,Track name,Artist name\nA,One,X\nB,Two,Y\nA,Three,Z\n'
    const parsed = parseCsvImport(text)
    expect(parsed.collections.map((collection) => collection.name)).toEqual(['A', 'B'])
    expect(parsed.collections[0]?.rows.map((row) => row.title)).toEqual(['One', 'Three'])
  })

  it('counts rows without a title, duplicates, local files and episodes as skipped', () => {
    const text = [
      'Track URI,Track Name,Artist Name(s)',
      'spotify:track:0000000000000000000001,One,A',
      'spotify:track:0000000000000000000001,One again,A',
      ',,B',
      'spotify:local:Artist:Album:Title:180,Title,Artist',
      'spotify:episode:0000000000000000000009,Episode,Show',
      ',Two,B',
      ',two,b',
    ].join('\n')
    const parsed = parseCsvImport(text)
    expect(parsed.collections[0]?.rows.map((row) => row.title)).toEqual(['One', 'Two'])
    expect(parsed.skipped).toMatchObject({
      unreadable: 1,
      duplicates: 2,
      localFiles: 1,
      episodes: 1,
    })
  })

  it('refuses a file without a title column, an empty file and one without songs', () => {
    const codeOf = (text: string) => {
      try {
        parseCsvImport(text)
        return 'parsed'
      } catch (error) {
        return isImportInputError(error) ? error.code : 'other'
      }
    }
    expect(codeOf('Artist,Album\nA,B')).toBe('no-title-column')
    expect(codeOf('')).toBe('empty')
    expect(codeOf('Title,Artist\n,A')).toBe('no-tracks')
  })

  it('ignores lengths, dates and ISRCs it cannot believe', () => {
    const text =
      'Title,Duration (ms),Release Date,ISRC,Explicit\nSong,12,0099-01-01,NOTANISRC,maybe\n'
    const [row] = parseCsvImport(text).collections[0]?.rows ?? []
    expect(row).toEqual({ title: 'Song', artists: [] })
  })
})

describe('nameFromFileName', () => {
  it('drops folders and the extension and turns underscores into spaces', () => {
    expect(nameFromFileName('C:\\Users\\me\\liked_songs.csv', 'x')).toBe('liked songs')
    expect(nameFromFileName('/tmp/.csv', 'Fallback')).toBe('Fallback')
  })
})
