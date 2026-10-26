import { describe, expect, it } from 'vitest'
import { utf8 } from '../bytes'
import {
  filler,
  flacFile,
  id3Summary,
  mp3File,
  oggOpusFile,
  oggPage,
  oggVorbisFile,
  readFlacBlocks,
  readId3v2,
  readOggPackets,
  readOggPages,
  readRiffChunks,
  readVorbisComments,
  riff,
  riffChunk,
  sineWav,
} from '../testing'
import type { CoverArt, ExportTags } from '../types'
import { writeFlacTags } from './flac'
import { buildId3v2, id3v2Length, stripId3v2, writeMp3Tags } from './id3v2'
import { writeOggTags } from './ogg'
import { writeWavTags } from './riff'

// A tiny "PNG": the signature and an IHDR with the size, which is all the writers look at.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0,
  0, 0, 2, 0, 8, 2, 0, 0, 0,
])
const COVER: CoverArt = { mimeType: 'image/png', data: PNG, width: 512, height: 512 }

const TAGS: ExportTags = {
  title: 'Blitzkrieg Bop – Remastered',
  artists: ['Ramones', 'Guest Ünïcode'],
  album: 'Ramones',
  trackNumber: 1,
  discNumber: 1,
  releaseDate: '1976-04-23',
  isrc: 'USWB10000001',
  lyrics: 'Hey ho\nLet’s go',
  syncedLyrics: [
    { timeMs: 1000, text: 'Hey ho' },
    { timeMs: 2500, text: 'Let’s go' },
  ],
  cover: COVER,
}

describe('ID3v2.3 (MP3)', () => {
  it('writes every field as UTF-16 text frames, the lyrics, synced lyrics and the cover', () => {
    const tag = buildId3v2(TAGS)
    expect(readId3v2(tag)?.version).toBe(3)
    expect(id3Summary(tag)).toEqual({
      TIT2: 'Blitzkrieg Bop – Remastered',
      TPE1: 'Ramones, Guest Ünïcode',
      TALB: 'Ramones',
      TRCK: '1',
      TPOS: '1',
      TYER: '1976',
      TSRC: 'USWB10000001',
      USLT: 'Hey ho\nLet’s go',
      SYLT: 'format 2 content 1',
      APIC: 'image/png type 3',
    })
    const apic = readId3v2(tag)?.frames.find((frame) => frame.id === 'APIC')
    expect(apic?.body.subarray(-PNG.length)).toEqual(PNG)
  })

  it('leaves out what the track lacks', () => {
    expect(Object.keys(id3Summary(buildId3v2({ title: 'Only a title', artists: [] })))).toEqual([
      'TIT2',
    ])
  })

  it('times synced lyrics in milliseconds, each line after its text', () => {
    const sylt = readId3v2(buildId3v2(TAGS))?.frames.find((frame) => frame.id === 'SYLT')
    const body = sylt?.body ?? new Uint8Array()
    // The last four bytes are the last line's time: 2500 ms.
    expect(new DataView(body.buffer, body.byteOffset).getUint32(body.length - 4)).toBe(2500)
  })

  it('replaces earlier ID3v2 tags and an ID3v1 tag, keeping the audio frames', () => {
    const old = buildId3v2({ title: 'Old title', artists: ['Old'] })
    const frames = mp3File({ frames: 5 })
    const file = mp3File({ frames: 5, prefix: new Uint8Array([...old, ...old]), id3v1Title: 'Old' })
    const tagged = writeMp3Tags(file, TAGS)
    expect(id3Summary(tagged).TIT2).toBe(TAGS.title)
    const audio = tagged.subarray(id3v2Length(tagged))
    expect(audio).toEqual(frames)
    expect(stripId3v2(tagged)).toEqual(frames)
  })

  it('reads the length of a version 2.4 tag with a footer', () => {
    const tag = new Uint8Array(30)
    tag.set(utf8('ID3'))
    tag[3] = 4
    tag[5] = 0x10
    tag[9] = 10
    expect(id3v2Length(tag)).toBe(30)
    expect(id3v2Length(utf8('not a tag'))).toBe(0)
  })
})

describe('FLAC', () => {
  it('replaces the comments and pictures, keeps the vendor, STREAMINFO, SEEKTABLE and frames', () => {
    const frames = filler(500, 9)
    const file = flacFile({
      comments: [
        ['TITLE', 'Wrong'],
        ['REPLAYGAIN_TRACK_GAIN', '-3 dB'],
      ],
      seekTable: true,
      picture: new Uint8Array(40),
      frames,
    })
    const tagged = writeFlacTags(file, TAGS)
    const { blocks, framesAt } = readFlacBlocks(tagged)
    expect(blocks.map((block) => block.type)).toEqual([0, 3, 4, 6])
    expect(blocks.map((block) => block.last)).toEqual([false, false, false, true])
    expect(tagged.subarray(framesAt)).toEqual(frames)
    const comments = readVorbisComments(blocks[2]?.body ?? new Uint8Array())
    expect(comments.vendor).toBe('reference libFLAC 1.4.3')
    expect(comments.fields).toEqual([
      ['TITLE', 'Blitzkrieg Bop – Remastered'],
      ['ARTIST', 'Ramones'],
      ['ARTIST', 'Guest Ünïcode'],
      ['ALBUM', 'Ramones'],
      ['TRACKNUMBER', '1'],
      ['DISCNUMBER', '1'],
      ['DATE', '1976-04-23'],
      ['ISRC', 'USWB10000001'],
      ['LYRICS', 'Hey ho\nLet’s go'],
    ])
    const picture = blocks[3]?.body ?? new Uint8Array()
    const view = new DataView(picture.buffer, picture.byteOffset)
    expect(view.getUint32(0)).toBe(3)
    expect(new TextDecoder().decode(picture.subarray(8, 8 + view.getUint32(4)))).toBe('image/png')
    expect(picture.subarray(-PNG.length)).toEqual(PNG)
  })

  it('drops an ID3v2 tag before the stream and writes the plain lyrics of synced ones', () => {
    const file = flacFile({ prefix: buildId3v2({ title: 'x', artists: [] }) })
    const tagged = writeFlacTags(file, {
      title: 'Song',
      artists: ['A'],
      syncedLyrics: [{ timeMs: 0, text: 'Only synced' }],
    })
    expect(new TextDecoder().decode(tagged.subarray(0, 4))).toBe('fLaC')
    const comments = readVorbisComments(readFlacBlocks(tagged).blocks[1]?.body ?? new Uint8Array())
    expect(comments.fields).toContainEqual(['LYRICS', 'Only synced'])
  })

  it('refuses what isn’t a FLAC stream', () => {
    expect(() => writeFlacTags(mp3File(), TAGS)).toThrow(RangeError)
    expect(() => writeFlacTags(utf8('fLaC'), TAGS)).toThrow(RangeError)
  })
})

describe('Ogg', () => {
  it('replaces the Opus comment header and keeps the audio packets byte for byte', () => {
    const file = oggOpusFile({ comments: [['TITLE', 'Wrong']] })
    const before = readOggPackets(readOggPages(file))
    const result = writeOggTags(file, TAGS)
    expect(result.tagged).toBe(true)
    const pages = readOggPages(result.bytes)
    expect(pages.every((page) => page.crcValid)).toBe(true)
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index))
    const packets = readOggPackets(pages)
    expect(packets[0]).toEqual(before[0])
    expect(packets.slice(2)).toEqual(before.slice(2))
    const comments = readVorbisComments((packets[1] ?? new Uint8Array()).subarray(8))
    expect(comments.vendor).toBe('libopus 1.6.1')
    expect(comments.fields.map(([name]) => name)).toEqual([
      'TITLE',
      'ARTIST',
      'ARTIST',
      'ALBUM',
      'TRACKNUMBER',
      'DISCNUMBER',
      'DATE',
      'ISRC',
      'LYRICS',
      'METADATA_BLOCK_PICTURE',
    ])
    // The audio pages keep their granule positions.
    expect(pages.slice(-3).map((page) => page.granule)).toEqual(
      readOggPages(file)
        .slice(-3)
        .map((page) => page.granule),
    )
  })

  it('spreads a large comment header over several pages and renumbers the rest', () => {
    const cover: CoverArt = { mimeType: 'image/jpeg', data: new Uint8Array(150_000) }
    const file = oggOpusFile()
    const result = writeOggTags(file, { title: 'Big cover', artists: [], cover })
    const pages = readOggPages(result.bytes)
    expect(pages.every((page) => page.crcValid)).toBe(true)
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index))
    // 150 kB becomes 200 kB of base64: four pages of 65,025 bytes at most.
    const headerPages = pages.slice(1, -3)
    expect(headerPages.length).toBe(4)
    expect(headerPages.slice(1).every((page) => page.flags & 0x01)).toBe(true)
    expect(headerPages.slice(0, -1).every((page) => page.granule === -1n)).toBe(true)
    expect(headerPages.at(-1)?.granule).toBe(0n)
    const packets = readOggPackets(pages)
    expect(packets.slice(2)).toEqual(readOggPackets(readOggPages(file)).slice(2))
  })

  it('tags Ogg Vorbis, keeping the setup header and the framing bit', () => {
    const file = oggVorbisFile({ comments: [['ARTIST', 'Wrong']] })
    const before = readOggPackets(readOggPages(file))
    const result = writeOggTags(file, { title: 'Vorbis song', artists: ['A'] })
    const packets = readOggPackets(readOggPages(result.bytes))
    expect(packets[2]).toEqual(before[2])
    expect(packets.slice(3)).toEqual(before.slice(3))
    const comment = packets[1] ?? new Uint8Array()
    expect(comment[0]).toBe(3)
    expect(comment.at(-1)).toBe(1)
    expect(readVorbisComments(comment.subarray(7, -1)).fields).toEqual([
      ['TITLE', 'Vorbis song'],
      ['ARTIST', 'A'],
    ])
  })

  it('leaves other codecs in Ogg untouched', () => {
    const page = oggPage({
      serial: 1,
      sequence: 0,
      granule: 0,
      flags: 0x02,
      segments: [9],
      data: new Uint8Array([0x7f, 0x46, 0x4c, 0x41, 0x43, 1, 0, 0, 1]),
    })
    const result = writeOggTags(page, TAGS)
    expect(result).toEqual({ bytes: page, tagged: false })
  })

  it('refuses files that aren’t Ogg, and headers sharing a page with audio', () => {
    expect(() => writeOggTags(mp3File(), TAGS)).toThrow(RangeError)
    const head = readOggPackets(readOggPages(oggOpusFile()))
    const shared = new Uint8Array([
      ...oggPage({
        serial: 5,
        sequence: 0,
        granule: 0,
        flags: 2,
        segments: [19],
        data: head[0] ?? new Uint8Array(),
      }),
      ...oggPage({
        serial: 5,
        sequence: 1,
        granule: 960,
        segments: [head[1]?.length ?? 0, 3],
        data: new Uint8Array([...(head[1] ?? []), 1, 2, 3]),
      }),
    ])
    expect(() => writeOggTags(shared, TAGS)).toThrow(/share a page/)
  })
})

describe('WAV', () => {
  it('adds LIST/INFO and an ID3 chunk after the audio, replacing old ones', () => {
    const file = sineWav({ seconds: 0.05 })
    const chunks = readRiffChunks(file)
    const old = riff([
      ...chunks.map((chunk) => riffChunk(chunk.id, chunk.data)),
      riffChunk('LIST', new Uint8Array([...utf8('INFO'), ...riffChunk('INAM', utf8('Old\0'))])),
      riffChunk('id3 ', buildId3v2({ title: 'Old', artists: [] })),
    ])
    const tagged = writeWavTags(old, TAGS)
    const result = readRiffChunks(tagged)
    expect(result.map((chunk) => chunk.id)).toEqual(['fmt ', 'data', 'LIST', 'id3 '])
    expect(result[1]?.data).toEqual(chunks[1]?.data)
    expect(new DataView(tagged.buffer).getUint32(4, true)).toBe(tagged.length - 8)
    const info = result[2]?.data ?? new Uint8Array()
    expect(new TextDecoder().decode(info.subarray(0, 4))).toBe('INFO')
    expect(new TextDecoder().decode(info)).toContain('Blitzkrieg Bop')
    expect(id3Summary(result[3]?.data ?? new Uint8Array()).TIT2).toBe(TAGS.title)
  })

  it('refuses a WAV whose chunks run past its end, and other files', () => {
    const file = sineWav({ seconds: 0.05 })
    expect(() => writeWavTags(file.subarray(0, 100), TAGS)).toThrow(RangeError)
    expect(() => writeWavTags(mp3File(), TAGS)).toThrow(RangeError)
  })
})

describe('a file converted from lossy audio', () => {
  // YouTube's Opus (itag 251), as Save to device converts it.
  const CONVERTED: ExportTags = {
    title: 'Song',
    artists: ['Band'],
    convertedFrom: { codec: 'opus', bitrateKbps: 160.4 },
  }
  const NOTE = 'Converted by FXM from Opus (lossy, 160 kbps)'

  it('says so for people and for programs, in ID3v2 (MP3, and inside WAV)', () => {
    expect(id3Summary(buildId3v2(CONVERTED))).toEqual({
      TIT2: 'Song',
      TPE1: 'Band',
      COMM: `eng ${NOTE}`,
      'TXXX:FXM_SOURCE_CODEC': 'opus',
      'TXXX:FXM_SOURCE_BITRATE': '160',
    })
    // The audio of a video (YouTube's itag 18), whose bitrate isn't known.
    expect(
      id3Summary(
        buildId3v2({ ...CONVERTED, convertedFrom: { codec: 'aac', media: 'muxed-video' } }),
      ),
    ).toEqual({
      TIT2: 'Song',
      TPE1: 'Band',
      COMM: 'eng Converted by FXM from the AAC audio of a video (lossy)',
      'TXXX:FXM_SOURCE_CODEC': 'aac',
    })
  })

  it('says so in Vorbis comments (FLAC and Ogg)', () => {
    const { blocks } = readFlacBlocks(writeFlacTags(flacFile(), CONVERTED))
    expect(
      readVorbisComments(blocks.find((block) => block.type === 4)?.body ?? new Uint8Array()).fields,
    ).toEqual([
      ['TITLE', 'Song'],
      ['ARTIST', 'Band'],
      ['COMMENT', NOTE],
      ['FXM_SOURCE_CODEC', 'opus'],
      ['FXM_SOURCE_BITRATE', '160'],
    ])
    const ogg = writeOggTags(oggOpusFile(), { ...CONVERTED, convertedFrom: { codec: 'aac' } })
    const packets = readOggPackets(readOggPages(ogg.bytes))
    expect(readVorbisComments((packets[1] ?? new Uint8Array()).subarray(8)).fields).toEqual([
      ['TITLE', 'Song'],
      ['ARTIST', 'Band'],
      ['COMMENT', 'Converted by FXM from AAC (lossy)'],
      ['FXM_SOURCE_CODEC', 'aac'],
    ])
  })

  it('says so in WAV: the note in LIST/INFO, and everything in the ID3 chunk', () => {
    const chunks = readRiffChunks(writeWavTags(sineWav({ seconds: 0.05 }), CONVERTED))
    const info = new TextDecoder().decode(chunks.find((chunk) => chunk.id === 'LIST')?.data)
    expect(info).toContain(`ICMT`)
    expect(info).toContain(`${NOTE}\0`)
    expect(
      id3Summary(chunks.find((chunk) => chunk.id === 'id3 ')?.data ?? new Uint8Array()),
    ).toMatchObject({ 'TXXX:FXM_SOURCE_CODEC': 'opus', 'TXXX:FXM_SOURCE_BITRATE': '160' })
  })

  it('writes nothing of the kind for a file that wasn’t converted', () => {
    const plain: ExportTags = { title: 'Song', artists: ['Band'] }
    expect(Object.keys(id3Summary(buildId3v2(plain)))).toEqual(['TIT2', 'TPE1'])
    const { blocks } = readFlacBlocks(writeFlacTags(flacFile(), plain))
    expect(
      readVorbisComments(blocks.find((block) => block.type === 4)?.body ?? new Uint8Array()).fields,
    ).toEqual([
      ['TITLE', 'Song'],
      ['ARTIST', 'Band'],
    ])
  })
})
