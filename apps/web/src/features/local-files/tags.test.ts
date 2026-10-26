import { exportAudio, type SourceAudio, tagsFromTrack } from '@fxm/convert'
import { FakeFfmpegCore, itag18File } from '@fxm/convert/testing'
import { type DownloadFormat, formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isLossless, qualityLabel } from './format'
import {
  cleanDate,
  cleanText,
  convertedFromTags,
  loudnessOfTags,
  readTags,
  titleFromFileName,
} from './tags'
import {
  audioFile,
  flacFile,
  m4aFile,
  mp3File,
  opusFile,
  pngImage,
  type TestTags,
  wavFile,
} from './testing'

const TAGS: TestTags = {
  title: 'Night Drive',
  artists: ['Aria Vale', 'Theo Marsh'],
  albumArtist: 'Aria Vale',
  album: 'Neon Rivers',
  track: 3,
  trackTotal: 10,
  disc: 1,
  date: '2021-06-04',
  isrc: 'us-xyz-21-00001',
}

const COVER = { data: pngImage([200, 40, 120]), mime: 'image/png' }

async function read(bytes: Uint8Array, name: string) {
  const result = await readTags(audioFile(bytes, name), name)
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)
  return result
}

describe('readTags', () => {
  it('reads FLAC: Vorbis comments, the cover, and a lossless format', async () => {
    const result = await read(flacFile({ tags: TAGS, picture: COVER }), 'Night Drive.flac')
    expect(result.tags).toEqual({
      title: 'Night Drive',
      artists: ['Aria Vale', 'Theo Marsh'],
      albumArtist: 'Aria Vale',
      album: 'Neon Rivers',
      trackNumber: 3,
      discNumber: 1,
      releaseDate: '2021-06-04',
      isrc: 'USXYZ2100001',
      durationMs: 1022,
    })
    expect(result.format).toMatchObject({
      codec: 'flac',
      container: 'flac',
      tier: 'lossless',
      sampleRateHz: 44_100,
      bitDepth: 16,
    })
    expect(result.picture?.format).toBe('image/png')
    expect(result.picture?.data).toEqual(COVER.data)
  })

  it('reads MP3: ID3v2.4 frames, several artists, and a lossy format', async () => {
    const result = await read(mp3File({ tags: TAGS, picture: COVER }), 'night.mp3')
    expect(result.tags).toMatchObject({
      title: 'Night Drive',
      artists: ['Aria Vale', 'Theo Marsh'],
      album: 'Neon Rivers',
      trackNumber: 3,
      isrc: 'USXYZ2100001',
    })
    expect(result.format).toMatchObject({ codec: 'mp3', container: 'mp3', bitrateKbps: 128 })
    expect(result.format.tier).toBe('normal')
    expect(result.format.bitDepth).toBeUndefined()
    expect(result.picture?.format).toBe('image/png')
  })

  it('reads WAV: the id3 chunk, and a lossless format', async () => {
    const result = await read(
      wavFile({
        tags: { title: 'Room Tone', artists: ['Field Kit'] },
        sampleRate: 48_000,
        bitsPerSample: 24,
      }),
      'room.wav',
    )
    expect(result.tags).toMatchObject({
      title: 'Room Tone',
      artists: ['Field Kit'],
      durationMs: 1000,
    })
    expect(result.format).toMatchObject({
      codec: 'pcm',
      container: 'wav',
      tier: 'lossless',
      sampleRateHz: 48_000,
      bitDepth: 24,
    })
  })

  it('reads an extensible WAV, as ffmpeg writes 24-bit and 96 kHz ones, as lossless', async () => {
    const result = await read(
      wavFile({
        tags: { title: 'High Tide' },
        extensible: true,
        bitsPerSample: 24,
        sampleRate: 96_000,
        seconds: 0.25,
      }),
      'high tide.wav',
    )
    expect(result.tags).toMatchObject({ title: 'High Tide', durationMs: 250 })
    expect(result.format).toEqual({
      codec: 'pcm',
      container: 'wav',
      tier: 'lossless',
      bitrateKbps: 2304,
      sampleRateHz: 96_000,
      bitDepth: 24,
    })
  })

  it('reads extensible WAVs of floats, of 24 bits in 32 and after other chunks', async () => {
    const float = await read(
      wavFile({ extensible: true, float: true, bitsPerSample: 32, sampleRate: 48_000 }),
      'float.wav',
    )
    expect(float.format).toMatchObject({ codec: 'pcm', tier: 'lossless', bitDepth: 32 })
    const padded = await read(
      wavFile({
        extensible: true,
        bitsPerSample: 32,
        validBits: 24,
        sampleRate: 88_200,
        leading: [{ id: 'JUNK', data: new Uint8Array(29) }],
      }),
      'padded.wav',
    )
    expect(padded.format).toMatchObject({
      codec: 'pcm',
      tier: 'lossless',
      sampleRateHz: 88_200,
      bitDepth: 24,
    })
  })

  it('reads ALAC in M4A as lossless, and AAC in M4A as lossy', async () => {
    const alac = await read(
      m4aFile({ codec: 'alac', tags: TAGS, picture: COVER, bitsPerSample: 24 }),
      'night.m4a',
    )
    expect(alac.format).toMatchObject({
      codec: 'alac',
      container: 'm4a',
      tier: 'lossless',
      bitDepth: 24,
    })
    expect(alac.tags).toMatchObject({ title: 'Night Drive', album: 'Neon Rivers', trackNumber: 3 })
    expect(alac.tags.durationMs).toBe(2000)
    expect(alac.picture?.format).toBe('image/png')

    const aac = await read(m4aFile({ codec: 'mp4a', tags: TAGS }), 'night.m4a')
    expect(aac.format).toMatchObject({ codec: 'aac', container: 'm4a' })
    expect(aac.format.tier).not.toBe('lossless')
    expect(aac.format.bitDepth).toBeUndefined()
  })

  it('reads Opus in Ogg as lossy', async () => {
    const result = await read(
      opusFile({ tags: { title: 'Static', artists: ['Low Orbit'] } }),
      'static.opus',
    )
    expect(result.tags).toMatchObject({ title: 'Static', artists: ['Low Orbit'] })
    expect(result.tags.durationMs).toBe(1000)
    expect(result.format).toMatchObject({ codec: 'opus', container: 'ogg' })
    expect(result.format.tier).not.toBe('lossless')
  })

  it('takes the title from the file name when the file has none', async () => {
    const result = await read(flacFile(), '03 - Slow Tide.flac')
    expect(result.tags).toEqual({
      title: 'Slow Tide',
      artists: [],
      trackNumber: 3,
      durationMs: 1022,
    })
    expect(result.picture).toBeUndefined()
  })

  it('reads a file whose extension lies by its content', async () => {
    const result = await read(
      m4aFile({ codec: 'mp4a', tags: { title: 'Mislabelled' } }),
      'song.mp3',
    )
    expect(result.tags.title).toBe('Mislabelled')
    expect(result.format).toMatchObject({ codec: 'aac', container: 'm4a' })
  })

  it('reports a file it can not read', async () => {
    const result = await readTags(
      audioFile(new Uint8Array(64).fill(7), 'broken.flac'),
      'broken.flac',
    )
    expect(result.ok).toBe(false)
  })
})

describe('files FXM converted from lossy audio', () => {
  /** A YouTube Music song, as Save to device tags it. */
  const SONG: Track = {
    id: formatId('ytm', 'track', 'abc123def45'),
    source: 'ytm',
    title: 'Sine 440',
    artists: [{ name: 'FXM test' }],
    album: { name: 'Generated' },
    isrc: 'XXFXM2600001',
    artwork: [],
    kind: 'song',
  }
  /** YouTube's Opus (itag 251), as its download record describes it. */
  const OPUS: SourceAudio = { codec: 'opus', container: 'webm', media: 'audio', bitrateKbps: 160 }

  /** Saves the song as `format` the way Save to device does, with a stand-in for the core. */
  async function saved(format: DownloadFormat, source: SourceAudio = OPUS) {
    // A video's audio is extracted first, so it has to be a real MP4 (generated, filler audio).
    const input = source.media === 'muxed-video' ? itag18File() : new Uint8Array(16)
    const result = await exportAudio(
      { input, source, format, tags: tagsFromTrack(SONG) },
      { loadCore: async () => new FakeFfmpegCore() },
    )
    const name = `FXM test - Sine 440.${result.plan.output.extension}`
    return read(new Uint8Array(await result.blob.arrayBuffer()), name)
  }

  it('reads a FLAC saved from Opus as converted, with the Opus’s quality, never lossless', async () => {
    const { format, tags } = await saved('flac')
    expect(format).toMatchObject({
      codec: 'flac',
      container: 'flac',
      tier: 'high',
      convertedFrom: { codec: 'opus', bitrateKbps: 160 },
    })
    expect(isLossless(format)).toBe(false)
    expect(qualityLabel(format)).toBe('FLAC · converted from Opus')
    // The rest of the tags read as before: it still plays as the song's offline copy.
    expect(tags).toMatchObject({ title: 'Sine 440', artists: ['FXM test'], isrc: 'XXFXM2600001' })
  })

  it('reads a WAV saved from Opus (its id3 chunk) as converted', async () => {
    const { format } = await saved('wav')
    expect(format).toMatchObject({ codec: 'pcm', tier: 'high', convertedFrom: { codec: 'opus' } })
    expect(isLossless(format)).toBe(false)
    expect(qualityLabel(format)).toBe('WAV · converted from Opus')
  })

  it('reads an M4A and an MP3 saved from lossy audio as converted too', async () => {
    // The stand-in core answers ALAC with an M4A whose track is AAC: the iTunes atoms matter here.
    const m4a = await saved('alac')
    expect(m4a.format.convertedFrom).toEqual({ codec: 'opus', bitrateKbps: 160 })
    expect(isLossless(m4a.format)).toBe(false)
    // From the AAC of YouTube's itag 18, whose bitrate the download didn't know.
    const mp3 = await saved('mp3', { codec: 'aac', container: 'mp4', media: 'muxed-video' })
    expect(mp3.format).toMatchObject({ codec: 'mp3', convertedFrom: { codec: 'aac' } })
    expect(mp3.format.convertedFrom?.bitrateKbps).toBeUndefined()
    expect(qualityLabel(mp3.format)).toBe('MP3 · converted from AAC')
  })

  it('keeps a real lossless file lossless: a FLAC saved from FLAC, the original, another tagger', async () => {
    const fromFlac = await saved('alac', { codec: 'flac', container: 'flac', media: 'audio' })
    expect(fromFlac.format.convertedFrom).toBeUndefined()
    const flac = await read(
      flacFile({ tags: { ...TAGS, extra: [['FXM_SOURCE_CODEC', 'flac']] } }),
      'Night Drive.flac',
    )
    // A source codec that isn't lossy says nothing.
    expect(flac.format).toMatchObject({ tier: 'lossless' })
    expect(flac.format.convertedFrom).toBeUndefined()
    expect(isLossless(flac.format)).toBe(true)
  })

  it('reads the source from any tag format, and believes only sensible bitrates', () => {
    expect(
      convertedFromTags({
        vorbis: [
          { id: 'fxm_source_codec', value: ' Opus ' },
          { id: 'FXM_SOURCE_BITRATE', value: '141' },
        ],
      }),
    ).toEqual({ codec: 'opus', bitrateKbps: 141 })
    expect(
      convertedFromTags({ 'ID3v2.3': [{ id: 'TXXX:FXM_SOURCE_CODEC', value: ['aac'] }] }),
    ).toEqual({ codec: 'aac' })
    expect(
      convertedFromTags({
        iTunes: [
          { id: '----:com.apple.iTunes:FXM_SOURCE_CODEC', value: 'mp3' },
          { id: '----:com.apple.iTunes:FXM_SOURCE_BITRATE', value: '99999' },
        ],
      }),
    ).toEqual({ codec: 'mp3' })
    expect(
      convertedFromTags({ vorbis: [{ id: 'FXM_SOURCE_CODEC', value: 'pcm' }] }),
    ).toBeUndefined()
    expect(convertedFromTags({})).toBeUndefined()
    expect(convertedFromTags(undefined)).toBeUndefined()
  })
})

describe('loudness tags', () => {
  it('reads ReplayGain from a FLAC file', async () => {
    const extra: [string, string][] = [
      ['REPLAYGAIN_TRACK_GAIN', '-7.89 dB'],
      ['REPLAYGAIN_TRACK_PEAK', '0.988525'],
      ['REPLAYGAIN_ALBUM_GAIN', '-8.20 dB'],
      ['REPLAYGAIN_ALBUM_PEAK', '1.000000'],
    ]
    const result = await read(flacFile({ tags: { ...TAGS, extra } }), 'Night Drive.flac')
    expect(result.tags.loudness).toEqual({
      trackLufs: -10.11,
      trackPeak: 0.988525,
      albumLufs: -9.8,
      albumPeak: 1,
      source: 'replaygain',
    })
  })

  it('reads gains however taggers write them', async () => {
    for (const gain of ['-7.89dB', '-7,89 dB', '-7.89']) {
      const extra: [string, string][] = [
        ['REPLAYGAIN_TRACK_GAIN', gain],
        ['REPLAYGAIN_TRACK_PEAK', '0,5'],
      ]
      const result = await read(flacFile({ tags: { ...TAGS, extra } }), 'Night Drive.flac')
      expect(result.tags.loudness, gain).toEqual({
        trackLufs: -10.11,
        trackPeak: 0.5,
        source: 'replaygain',
      })
    }
  })

  it('reads ReplayGain from ID3 and iTunes tags, whatever the case of their names', () => {
    const id3 = loudnessOfTags({
      common: {},
      native: {
        'ID3v2.4': [
          { id: 'TXXX:replaygain_track_gain', value: '-7,89 dB' },
          { id: 'TXXX:REPLAYGAIN_ALBUM_GAIN', value: '-8.20 dB' },
        ],
      },
    } as never)
    expect(id3).toEqual({ trackLufs: -10.11, albumLufs: -9.8, source: 'replaygain' })
    const itunes = loudnessOfTags({
      common: {},
      native: {
        iTunes: [
          { id: '----:com.apple.iTunes:replaygain_track_gain', value: '+2.5dB' },
          { id: '----:com.apple.iTunes:replaygain_track_peak', value: '0.25' },
        ],
      },
    } as never)
    expect(itunes).toEqual({ trackLufs: -20.5, trackPeak: 0.25, source: 'replaygain' })
  })

  it('reads R128 gains from an Opus file', async () => {
    const extra: [string, string][] = [
      ['R128_TRACK_GAIN', '-1280'],
      ['R128_ALBUM_GAIN', '-1024'],
    ]
    const result = await read(opusFile({ tags: { title: 'Quiet', extra } }), 'quiet.opus')
    expect(result.tags.loudness).toEqual({ trackLufs: -18, albumLufs: -19, source: 'r128' })
  })

  it('leaves loudness out without valid tags', async () => {
    const result = await read(flacFile({ tags: TAGS }), 'Night Drive.flac')
    expect(result.tags.loudness).toBeUndefined()
    // Without the tag's own text, a gain the parser read as a ratio (no unit) says nothing.
    const unitless = loudnessOfTags({
      common: { replaygain_track_gain: { dB: Number.NaN, ratio: -7.89 } },
    } as never)
    expect(unitless).toBeUndefined()
  })

  it('prefers ReplayGain to R128 outside Opus files', () => {
    const loudness = loudnessOfTags({
      common: { replaygain_track_gain: { dB: -3, ratio: 0.7 } },
      native: { vorbis: [{ id: 'R128_TRACK_GAIN', value: '-1280' }] },
      format: { codec: 'FLAC' },
    } as never)
    expect(loudness?.source).toBe('replaygain')
  })
})

describe('titleFromFileName', () => {
  it.each([
    ['01 - Song.flac', 'Song', 1],
    ['01. Song.mp3', 'Song', 1],
    ['1) Song.mp3', 'Song', 1],
    ['07 Song Title.m4a', 'Song Title', 7],
    ['1-03 Song.flac', 'Song', 3],
    ['12-Song.mp3', 'Song', 12],
    ['02_Under_Score.mp3', 'Under Score', 2],
    ['99 Luftballons.mp3', '99 Luftballons', undefined],
    ['1979.mp3', '1979', undefined],
    ['3.14 Pi.mp3', '3.14 Pi', undefined],
    ['Song.mp3', 'Song', undefined],
    ['01.mp3', '01', undefined],
  ])('%s is "%s"', (name, title, trackNumber) => {
    const result = titleFromFileName(name)
    expect(result.title).toBe(title)
    expect(result.trackNumber).toBe(trackNumber)
  })
})

describe('cleaning', () => {
  it('trims, drops control characters and caps the length', () => {
    expect(cleanText('  Hello\u0000 world \n')).toBe('Hello world')
    expect(cleanText('   ')).toBeUndefined()
    expect(cleanText(42)).toBeUndefined()
    expect(cleanText('x'.repeat(600))?.length).toBe(500)
  })

  it('keeps ISO dates, possibly partial, and falls back to the year', () => {
    expect(cleanDate('2013-05-17', 2013)).toBe('2013-05-17')
    expect(cleanDate('2013-05-17T10:00:00Z', undefined)).toBe('2013-05-17')
    expect(cleanDate('2013-05', undefined)).toBe('2013-05')
    expect(cleanDate('May 2013', 2013)).toBe('2013')
    expect(cleanDate(undefined, 1999)).toBe('1999')
    expect(cleanDate('0000', 0)).toBeUndefined()
    expect(cleanDate(undefined, 99)).toBeUndefined()
  })
})
