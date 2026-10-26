import { describe, expect, it } from 'vitest'
import { concat, readU32BE } from '../bytes'
import {
  aacSampleEntry,
  aacSamples,
  fragmentedM4aFile,
  itag18File,
  m4aFile,
  mp3File,
  readMp4Tags,
  topLevelBoxes,
} from '../testing'
import { childBoxes, findBox } from './boxes'
import { demuxMp4Audio } from './demux'
import { writeM4a } from './write'

describe('demuxMp4Audio', () => {
  it('reads the audio of a plain M4A file: sample entry, timescales, samples, priming', () => {
    const samples = aacSamples(12)
    const track = demuxMp4Audio(m4aFile({ samples, mediaTime: 1024 }))
    expect(track.type).toBe('mp4a')
    expect(track.sampleEntry).toEqual(aacSampleEntry())
    expect(track.timescale).toBe(44100)
    expect(track.movieTimescale).toBe(1000)
    expect(track.mediaTime).toBe(1024)
    expect(track.samples.map((sample) => sample.data)).toEqual(samples.map((sample) => sample.data))
    expect(track.samples.every((sample) => sample.duration === 1024)).toBe(true)
  })

  it('takes only the AAC track of a video (itag 18), never the video', () => {
    const audio = aacSamples(16)
    const track = demuxMp4Audio(itag18File({ audio, videoFrames: 6 }))
    expect(track.type).toBe('mp4a')
    expect(track.samples.map((sample) => sample.data)).toEqual(audio.map((sample) => sample.data))
    expect(track.mediaTime).toBe(1024)
  })

  it('reads a fragmented M4A file like YouTube’s audio', () => {
    const samples = aacSamples(20)
    const track = demuxMp4Audio(fragmentedM4aFile({ samples, perFragment: 6 }))
    expect(track.samples.map((sample) => sample.data)).toEqual(samples.map((sample) => sample.data))
    expect(track.samples.map((sample) => sample.duration)).toEqual(samples.map(() => 1024))
  })

  it('refuses a file that isn’t MP4 as damaged, and one without AAC or ALAC as unsupported', () => {
    expect(() => demuxMp4Audio(mp3File())).toThrow(
      expect.objectContaining({ name: 'ConvertError', code: 'corrupt-input' }),
    )
    // The same M4A with its sample entry renamed: Opus in MP4, which FXM doesn't take.
    const opus = m4aFile()
    const at = new TextDecoder('latin1').decode(opus).indexOf('mp4a')
    opus.set(new TextEncoder().encode('Opus'), at)
    expect(() => demuxMp4Audio(opus)).toThrow(
      expect.objectContaining({ name: 'ConvertError', code: 'unsupported-input' }),
    )
  })
})

describe('writeM4a', () => {
  it('writes the movie box first, then the samples, with offsets a reader follows', () => {
    const samples = aacSamples(100)
    const bytes = concat(
      writeM4a({
        type: 'mp4a',
        sampleEntry: aacSampleEntry(),
        timescale: 44100,
        movieTimescale: 1000,
        samples,
      }),
    )
    expect(topLevelBoxes(bytes)).toEqual(['ftyp', 'moov', 'mdat'])
    const again = demuxMp4Audio(bytes)
    expect(again.samples.map((sample) => sample.data)).toEqual(samples.map((sample) => sample.data))
    expect(again.mediaTime).toBeUndefined()
    // About a second per chunk: 100 samples of 1024 at 44.1 kHz make three chunks.
    const stco = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])
    expect(stco && readU32BE(bytes, stco.offset + 12)).toBe(3)
  })

  it('keeps the encoder’s priming as an edit list', () => {
    const bytes = m4aFile({ mediaTime: 2112 })
    const elst = findBox(bytes, ['moov', 'trak', 'edts', 'elst'])
    expect(elst).toBeDefined()
    expect(elst && readU32BE(bytes, elst.offset + 20)).toBe(2112)
    expect(demuxMp4Audio(bytes).mediaTime).toBe(2112)
  })

  it('writes iTunes tags: text, track, disc, lyrics, cover and the ISRC', () => {
    const track = demuxMp4Audio(itag18File())
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const bytes = concat(
      writeM4a(track, {
        title: 'Title',
        artists: ['A', 'B'],
        album: 'Album',
        trackNumber: 3,
        discNumber: 2,
        releaseDate: '2001-02-03',
        isrc: 'GBARL9300135',
        lyrics: 'La la',
        cover: { mimeType: 'image/jpeg', data: cover },
      }),
    )
    expect(readMp4Tags(bytes)).toEqual({
      '©nam': 'Title',
      '©ART': 'A, B',
      '©alb': 'Album',
      trkn: '3',
      disk: '2',
      '©day': '2001-02-03',
      '©lyr': 'La la',
      covr: 'type 13, 7 bytes',
      '----:ISRC': 'GBARL9300135',
    })
    const meta = findBox(bytes, ['moov', 'udta', 'meta'])
    const hdlr = meta && childBoxes(bytes, meta.offset + 12, meta.offset + meta.length)[0]
    expect(hdlr?.type).toBe('hdlr')
    // Still a valid file: the samples read back after the tags.
    expect(demuxMp4Audio(bytes).samples.length).toBe(track.samples.length)
  })

  it('uses 64-bit durations when 32 bits are too few', () => {
    const bytes = concat(
      writeM4a({
        type: 'mp4a',
        sampleEntry: aacSampleEntry(),
        timescale: 44100,
        movieTimescale: 1000,
        samples: [{ data: new Uint8Array(10), duration: 2 ** 32 + 5 }],
      }),
    )
    const mdhd = findBox(bytes, ['moov', 'trak', 'mdia', 'mdhd'])
    expect(mdhd && bytes[mdhd.offset + 8]).toBe(1)
  })
})
