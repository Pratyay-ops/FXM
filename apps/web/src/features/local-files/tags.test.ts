import { describe, expect, it } from 'vitest'
import { cleanDate, cleanText, loudnessOfTags, readTags, titleFromFileName } from './tags'
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
    // A gain written without its unit reads as a ratio, which says nothing.
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
