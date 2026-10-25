import { describe, expect, it } from 'vitest'
import { isImportInputError } from './errors'
import { decodeText, describeFileName, parseM3uImport } from './m3u'

describe('parseM3uImport', () => {
  it('reads #EXTINF lengths and "Artist - Title", and #PLAYLIST for the name', () => {
    const text = [
      '#EXTM3U',
      '#PLAYLIST:Evening',
      '#EXTINF:238,Radiohead - Creep',
      'C:\\Music\\Radiohead\\Pablo Honey\\02 Creep.mp3',
      '#EXTINF:-1 tvg-name="x, y",Daft Punk – One More Time',
      'http://radio.example/stream.mp3',
      '',
    ].join('\r\n')
    const parsed = parseM3uImport(text, 'evening.m3u8')
    expect(parsed.kind).toBe('m3u')
    expect(parsed.label).toBe('evening.m3u8')
    expect(parsed.collections[0]?.name).toBe('Evening')
    expect(parsed.collections[0]?.rows).toEqual([
      {
        title: 'Creep',
        artists: ['Radiohead'],
        durationMs: 238_000,
        location: 'C:\\Music\\Radiohead\\Pablo Honey\\02 Creep.mp3',
      },
      {
        title: 'One More Time',
        artists: ['Daft Punk'],
        location: 'http://radio.example/stream.mp3',
      },
    ])
  })

  it('reads titles, artists and albums from file names and folders without #EXTINF', () => {
    const text = [
      '/home/me/Music/Massive Attack/Mezzanine/01 - Angel.flac',
      '../Downloads/03. Portishead - Roads.mp3',
      '/home/me/Music/07 Loose Song.ogg',
      'file:///Users/me/Music/Bj%C3%B6rk/Debut/02%20Venus%20as%20a%20Boy.m4a',
    ].join('\n')
    const rows = parseM3uImport(text, 'mix.m3u').collections[0]?.rows
    expect(rows?.map(({ title, artists, album }) => ({ title, artists, album }))).toEqual([
      { title: 'Angel', artists: ['Massive Attack'], album: 'Mezzanine' },
      { title: 'Roads', artists: ['Portishead'], album: undefined },
      { title: 'Loose Song', artists: [], album: undefined },
      { title: 'Venus as a Boy', artists: ['Björk'], album: 'Debut' },
    ])
    expect(parseM3uImport(text, 'mix.m3u').collections[0]?.name).toBe('mix')
  })

  it('uses #EXTALB and #EXTART, and names catalog tracks by their links', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:200,Some Title',
      '#EXTART:Some Artist',
      '#EXTALB:Some Album',
      'song.mp3',
      '#EXTINF:215,Rick Astley - Never Gonna Give You Up',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://open.spotify.com/track/0000000000000000000005',
    ].join('\n')
    const rows = parseM3uImport(text).collections[0]?.rows
    expect(rows?.[0]).toMatchObject({
      title: 'Some Title',
      artists: ['Some Artist'],
      album: 'Some Album',
    })
    expect(rows?.[1]).toMatchObject({
      title: 'Never Gonna Give You Up',
      artists: ['Rick Astley'],
      durationMs: 215_000,
      trackId: 'yt:track:dQw4w9WgXcQ',
    })
    // A bare link names the track; the import loads its title.
    expect(rows?.[2]).toEqual({
      title: '',
      artists: [],
      trackId: 'spotify:track:0000000000000000000005',
      location: 'https://open.spotify.com/track/0000000000000000000005',
    })
  })

  it('skips entries it cannot read and keeps each track once', () => {
    const text = ['#EXTINF:100,', 'https://example.com/', 'a.mp3', 'a.mp3', '#comment'].join('\n')
    const parsed = parseM3uImport(text)
    expect(parsed.collections[0]?.rows.map((row) => row.title)).toEqual(['a'])
    expect(parsed.skipped).toMatchObject({ unreadable: 1, duplicates: 1 })
  })

  it('refuses an empty file and one without songs', () => {
    const codeOf = (text: string) => {
      try {
        parseM3uImport(text)
        return 'parsed'
      } catch (error) {
        return isImportInputError(error) ? error.code : 'other'
      }
    }
    expect(codeOf(' \n\n')).toBe('empty')
    expect(codeOf('#EXTM3U\n#EXTINF:1,\n')).toBe('no-tracks')
  })
})

describe('describeFileName', () => {
  it('drops track numbers and extensions', () => {
    expect(describeFileName('1-02. Artist - Title.wav')).toEqual({
      artist: 'Artist',
      title: 'Title',
    })
    expect(describeFileName('Just_A_Title.mp3')).toEqual({ title: 'Just A Title' })
    expect(describeFileName('.mp3')).toBeUndefined()
  })
})

describe('decodeText', () => {
  it('reads UTF-8, and falls back to Windows-1252 for other bytes', () => {
    expect(decodeText(new TextEncoder().encode('\ufeffBjörk'))).toBe('Björk')
    expect(decodeText(new Uint8Array([0x42, 0x6a, 0xf6, 0x72, 0x6b]))).toBe('Björk')
  })
})
