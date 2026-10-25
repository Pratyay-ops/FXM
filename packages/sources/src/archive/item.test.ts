import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import missing from './fixtures/item-missing.json'
import ninGhosts from './fixtures/item-nin-ghosts.json'
import restricted from './fixtures/item-restricted.json'
import tuning77 from './fixtures/item-tuning-77.json'
import {
  type ArchiveItem,
  audioFormat,
  audioGroups,
  coverFiles,
  downloadUrl,
  groupField,
  groupWithFile,
  itemPageUrl,
  parseItem,
  parseLength,
  titleFromPath,
  toFile,
} from './item'

/** An item made of raw file entries, as the metadata API lists them. */
function itemWith(files: unknown[], metadata: Record<string, unknown> = {}): ArchiveItem {
  return parseItem('test-item', { metadata: { identifier: 'test-item', ...metadata }, files })
}

/** The playable file names of each group, best first. */
function playableNames(item: ArchiveItem): string[][] {
  return audioGroups(item).map((group) => group.playable.map((entry) => entry.file.name))
}

describe('audioFormat', () => {
  it.each([
    ['Flac', 'a.flac', { codec: 'flac', container: 'flac' }],
    ['24bit Flac', 'a.flac', { codec: 'flac', container: 'flac', bitDepth: 24 }],
    ['VBR MP3', 'a.mp3', { codec: 'mp3', container: 'mp3' }],
    ['320Kbps MP3', 'a.mp3', { codec: 'mp3', container: 'mp3', bitrateKbps: 320 }],
    ['64Kbps MP3', 'a.mp3', { codec: 'mp3', container: 'mp3', bitrateKbps: 64 }],
    ['Ogg Vorbis', 'a.ogg', { codec: 'vorbis', container: 'ogg' }],
    ['Apple Lossless Audio', 'a.m4a', { codec: 'alac', container: 'm4a' }],
    ['WAVE', 'a.wav', { codec: 'pcm', container: 'wav' }],
    ['Something New', 'a.opus', { codec: 'opus', container: 'ogg' }],
    ['Something New', 'a.M4A', { codec: 'aac', container: 'm4a' }],
    ['Lossless Audio', 'a.m4a', { codec: 'alac', container: 'm4a' }],
  ])('reads %s (%s)', (format, name, expected) => {
    expect(audioFormat({ format, name })).toEqual(expected)
  })

  it.each([
    ['PNG', 'a.png'],
    ['Spectrogram', 'a.png'],
    ['Shorten', 'a.shn'],
    ['AIFF', 'a.aiff'],
    ['Flac FingerPrint', 'a.ffp'],
    ['64Kbps MP3 ZIP', 'a.zip'],
    ['VBR M3U', 'a.m3u'],
    ['Metadata', 'a.flac'],
    ['constructor', 'a.txt'],
    ['', 'notes.txt'],
  ])('plays nothing in %j (%s)', (format, name) => {
    expect(audioFormat({ format, name })).toBeUndefined()
  })
})

describe('parseLength', () => {
  it.each([
    ['168.83', 168_830],
    ['02:48', 168_000],
    ['92:50', 5_570_000],
    ['1:02:03.5', 3_723_500],
    [5565.04, 5_565_040],
  ])('reads %j', (value, expected) => {
    expect(parseLength(value)).toBe(expected)
  })

  it.each(['', 'abc', '1:2:3:4', '-5', '0', '1e3', null, undefined, 200_000])(
    'refuses %j',
    (value) => {
      expect(parseLength(value)).toBeUndefined()
    },
  )
})

describe('toFile', () => {
  it('reads the fields FXM uses from a recorded entry', () => {
    const flac = ninGhosts.files.find((file) => file.name === '01_Ghosts_I.flac')
    expect(toFile(flac)).toEqual({
      name: '01_Ghosts_I.flac',
      format: 'Flac',
      source: 'original',
      size: 12916014,
      lengthMs: 168_830,
      title: '1 Ghosts I',
      artist: 'Nine Inch Nails',
      album: 'Ghosts I - IV',
      track: 1,
      width: expect.any(Number),
      height: expect.any(Number),
      private: false,
    })
  })

  it('reads track numbers such as 1/12, private flags and ISRCs among external identifiers', () => {
    expect(
      toFile({
        name: 'a.flac',
        format: 'Flac',
        source: 'original',
        track: '3/12',
        disc: '2',
        private: 'true',
        bitrate: '0',
        'external-identifier': ['urn:acoustid:x', 'urn:isrc:gb-aye-92-00070'],
      }),
    ).toMatchObject({ track: 3, disc: 2, private: true, isrc: 'GBAYE9200070' })
    expect(toFile({ name: 'a.mp3', track: 'A1', bitrate: 'n/a' })).toEqual({
      name: 'a.mp3',
      format: '',
      source: '',
      private: false,
    })
  })

  it('refuses an entry without a name', () => {
    expect(toFile({ format: 'Flac' })).toBeNull()
    expect(toFile('a.flac')).toBeNull()
  })
})

describe('parseItem', () => {
  it('reads the metadata FXM uses', () => {
    const item = parseItem('nineinchnails_ghosts_I_IV', ninGhosts)
    expect(item).toMatchObject({
      identifier: 'nineinchnails_ghosts_I_IV',
      title: 'Ghosts I - IV',
      creators: ['Nine Inch Nails'],
      date: '2008-03-02',
      licenseUrl: 'http://creativecommons.org/licenses/by-nc-sa/3.0/us/',
      mediatype: 'audio',
      restricted: false,
    })
    expect(item.files).toHaveLength(ninGhosts.files.length)
  })

  it('marks access-restricted items', () => {
    const item = parseItem('gd1977-06-09.28614.sbeok.flac16', restricted)
    expect(item).toMatchObject({ restricted: true, mediatype: 'etree', date: '1977-06-09' })
  })

  it('rejects an unknown or withdrawn item with NotFound', () => {
    for (const body of [missing, { is_dark: true, metadata: {} }]) {
      let caught: unknown
      try {
        parseItem('gone', body)
      } catch (error) {
        caught = error
      }
      expect(isFxmError(caught, 'NotFound')).toBe(true)
    }
  })

  it('rejects anything that is not an item with Parse', () => {
    for (const body of [null, [], 'html', { files: [] }, { metadata: {}, files: {} }]) {
      expect(() => parseItem('odd', body)).toThrow(expect.objectContaining({ code: 'Parse' }))
    }
  })

  it('takes the year when the item has no full date', () => {
    expect(itemWith([], { year: '1999' }).date).toBe('1999')
    expect(itemWith([], { date: 'unknown', year: 'n.d.' }).date).toBeUndefined()
  })
})

describe('audioGroups', () => {
  it('puts each recording’s original, second original and derivatives in one group', () => {
    const item = parseItem('nineinchnails_ghosts_I_IV', ninGhosts)
    const groups = audioGroups(item)
    expect(groups.map((group) => group.root.name)).toEqual([
      '01_Ghosts_I.flac',
      '02_Ghosts_I.flac',
      '03_Ghosts_I.flac',
    ])
    expect(playableNames(item)[0]).toEqual([
      '01_Ghosts_I.flac',
      '01_Ghosts_I_320kb.mp3',
      '01_Ghosts_I_vbr.mp3',
      '01_Ghosts_I.mp3',
      '01_Ghosts_I.ogg',
      '01_Ghosts_I_64kb.mp3',
    ])
    const [first] = groups
    expect(first?.playable.map((entry) => entry.bitrateKbps)).toEqual([612, 320, 178, 177, 100, 64])
  })

  it('keeps two originals apart when the uploader numbered them as two tracks', () => {
    const groups = audioGroups(parseItem('gd1977-12-31_505', tuning77))
    expect(groups.map((group) => group.root.name)).toEqual([
      'gd_1977_Tuning_77.flac',
      'gd_1977_Tuning_77_320.mp3',
    ])
    expect(groups[0]?.playable[0]?.format).toEqual({
      codec: 'flac',
      container: 'flac',
      bitDepth: 24,
    })
    expect(groups[1]?.playable.map((entry) => entry.file.name)).toEqual([
      'gd_1977_Tuning_77_320.mp3',
      'gd_1977_Tuning_77_320.ogg',
    ])
  })

  it('leaves private files out and keeps a group that still has public ones', () => {
    const item = parseItem('gd1977-06-09.28614.sbeok.flac16', restricted)
    const groups = audioGroups(item)
    expect(groups.map((group) => group.root.name)).toEqual([
      'gd77-06-09d1t01.flac',
      'gd77-06-09d1t02.flac',
    ])
    expect(playableNames(item)[0]).toEqual(['gd77-06-09d1t01.mp3', 'gd77-06-09d1t01.ogg'])
    const [first] = groups
    expect(first && groupField(first, 'title')).toBe('Mississippi Half-Step Uptown Toodeloo')
  })

  it('drops a recording with no playable public file', () => {
    const item = itemWith([
      { name: 'a.flac', format: 'Flac', source: 'original', private: 'true' },
      { name: 'b.shn', format: 'Shorten', source: 'original' },
      { name: 'cover.jpg', format: 'JPEG', source: 'original' },
    ])
    expect(audioGroups(item)).toEqual([])
  })

  it('groups the playable derivatives of an unplayable original under it', () => {
    const item = itemWith([
      { name: 't01.shn', format: 'Shorten', source: 'original', title: 'Song', track: '1' },
      { name: 't01.flac', format: 'Flac', source: 'derivative', original: 't01.shn' },
      { name: 't01.mp3', format: 'VBR MP3', source: 'derivative', original: 't01.shn' },
    ])
    const [group] = audioGroups(item)
    expect(group?.root.name).toBe('t01.shn')
    expect(group?.playable.map((entry) => entry.file.name)).toEqual(['t01.flac', 't01.mp3'])
  })

  it('follows chains of derivatives, and survives loops and missing originals', () => {
    const item = itemWith([
      { name: 'a.wav', format: 'WAVE', source: 'original', length: '100' },
      { name: 'a.flac', format: 'Flac', source: 'derivative', original: 'a.wav' },
      { name: 'a.mp3', format: 'VBR MP3', source: 'derivative', original: 'a.flac' },
      { name: 'loop1.mp3', format: 'VBR MP3', source: 'derivative', original: 'loop2.mp3' },
      { name: 'loop2.mp3', format: 'VBR MP3', source: 'derivative', original: 'loop1.mp3' },
      { name: 'orphan.ogg', format: 'Ogg Vorbis', source: 'derivative', original: 'gone.flac' },
    ])
    const groups = audioGroups(item)
    expect(groups.find((group) => group.root.name === 'a.wav')?.playable).toHaveLength(3)
    expect(groups.find((group) => group.root.name === 'orphan.ogg')?.files).toHaveLength(1)
    expect(groups.flatMap((group) => group.files.map((file) => file.name)).sort()).toEqual([
      'a.flac',
      'a.mp3',
      'a.wav',
      'loop1.mp3',
      'loop2.mp3',
      'orphan.ogg',
    ])
  })

  it('merges a second original only when title, track, disc and length agree', () => {
    const original = (name: string, format: string, fields: Record<string, string>) => ({
      name,
      format,
      source: 'original',
      title: 'Song',
      track: '1',
      length: '200',
      ...fields,
    })
    const merged = itemWith([
      original('a.flac', 'Flac', {}),
      original('a.mp3', '320Kbps MP3', { length: '201.5' }),
    ])
    expect(playableNames(merged)).toEqual([['a.flac', 'a.mp3']])
    for (const fields of [{ length: '203' }, { track: '2' }, { title: 'Other' }, { disc: '2' }]) {
      const apart = itemWith([
        original('a.flac', 'Flac', {}),
        original('b.mp3', '320Kbps MP3', fields),
      ])
      expect(audioGroups(apart)).toHaveLength(2)
    }
    const untitled = itemWith([
      { name: 'a.flac', format: 'Flac', source: 'original', length: '200' },
      { name: 'a.mp3', format: 'VBR MP3', source: 'original', length: '200' },
    ])
    expect(audioGroups(untitled)).toHaveLength(2)
  })

  it('orders tracks by disc, then track number, then path in natural order', () => {
    const item = itemWith([
      { name: 'd2t1.flac', format: 'Flac', source: 'original', disc: '2', track: '1' },
      { name: 'd1t2.flac', format: 'Flac', source: 'original', disc: '1', track: '2' },
      { name: 'd1t10.flac', format: 'Flac', source: 'original', disc: '1', track: '10' },
      { name: 'bonus10.flac', format: 'Flac', source: 'original' },
      { name: 'bonus9.flac', format: 'Flac', source: 'original' },
    ])
    expect(audioGroups(item).map((group) => group.root.name)).toEqual([
      'bonus9.flac',
      'bonus10.flac',
      'd1t2.flac',
      'd1t10.flac',
      'd2t1.flac',
    ])
  })

  it('finds a group by any of its files', () => {
    const groups = audioGroups(parseItem('nineinchnails_ghosts_I_IV', ninGhosts))
    expect(groupWithFile(groups, '02_Ghosts_I_64kb.mp3')?.root.name).toBe('02_Ghosts_I.flac')
    expect(groupWithFile(groups, '01_Ghosts_I.png')).toBeUndefined()
    expect(groupWithFile(groups, 'nothing.flac')).toBeUndefined()
  })
})

describe('item helpers', () => {
  it('builds download and page URLs with every path segment encoded', () => {
    expect(downloadUrl('item_1', 'disc 1/01 #1? Song.flac')).toBe(
      'https://archive.org/download/item_1/disc%201/01%20%231%3F%20Song.flac',
    )
    expect(itemPageUrl('nineinchnails_ghosts_I_IV')).toBe(
      'https://archive.org/details/nineinchnails_ghosts_I_IV',
    )
  })

  it('makes a title from a file path', () => {
    expect(titleFromPath('disc1/01_Ghosts_I.flac')).toBe('01 Ghosts I')
    expect(titleFromPath('no extension')).toBe('no extension')
    expect(titleFromPath('_.flac')).toBe('_.flac')
  })

  it('finds uploaded covers, largest first, and never private or derived ones', () => {
    const item = itemWith([
      { name: 'folder.jpg', format: 'JPEG', source: 'original', width: '300' },
      { name: 'art/Front Cover.PNG', format: 'PNG', source: 'original', width: '1200' },
      { name: 'cover_thumb.jpg', format: 'JPEG Thumb', source: 'derivative' },
      { name: 'cover.jpg', format: 'JPEG', source: 'original', private: 'true' },
      { name: 'back.jpg', format: 'JPEG', source: 'original' },
    ])
    expect(coverFiles(item).map((file) => file.name)).toEqual(['art/Front Cover.PNG', 'folder.jpg'])
  })
})
