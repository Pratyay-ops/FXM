/**
 * Writes an audio track into a new M4A file: one track, the sample entry kept byte for byte, the
 * movie box before the audio (players can start without reading to the end), and iTunes-style
 * tags (`moov/udta/meta/ilst`), the ones Apple's apps, Android and most players read.
 *
 * Tags: ©nam title, ©ART artists, ©alb album, trkn track, disk disc, ©day date, ©lyr lyrics,
 * covr cover, and the ISRC as a `----:com.apple.iTunes:ISRC` item.
 *
 * @module
 */

import { ByteWriter, latin1, utf8 } from '../bytes'
import { conversionNote, joinedArtists, plainLyrics, positive, sourceFields } from '../tags/fields'
import type { ExportTags } from '../types'
import { box, fullBox } from './boxes'
import type { Mp4AudioTrack } from './demux'

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

function matrix(writer: ByteWriter): ByteWriter {
  for (const value of IDENTITY_MATRIX) writer.u32be(value)
  return writer
}

/** A duration that fits 32 bits needs version 0 of a box, a longer one version 1. */
function fits32(value: number): boolean {
  return value <= 0xffffffff
}

function mvhd(timescale: number, duration: number): Uint8Array {
  const v1 = !fits32(duration)
  const writer = new ByteWriter()
  if (v1) writer.u64be(0).u64be(0).u32be(timescale).u64be(duration)
  else writer.u32be(0).u32be(0).u32be(timescale).u32be(duration)
  writer.u32be(0x00010000).u16be(0x0100).u16be(0).u32be(0).u32be(0)
  matrix(writer)
  for (let i = 0; i < 6; i++) writer.u32be(0)
  writer.u32be(2) // next track ID
  return fullBox('mvhd', v1 ? 1 : 0, 0, writer.finish())
}

function tkhd(duration: number): Uint8Array {
  const v1 = !fits32(duration)
  const writer = new ByteWriter()
  if (v1) writer.u64be(0).u64be(0).u32be(1).u32be(0).u64be(duration)
  else writer.u32be(0).u32be(0).u32be(1).u32be(0).u32be(duration)
  writer.u32be(0).u32be(0) // reserved
  writer.u16be(0).u16be(1) // layer, alternate group
  writer.u16be(0x0100).u16be(0) // volume, reserved
  matrix(writer)
  writer.u32be(0).u32be(0) // width, height
  return fullBox('tkhd', v1 ? 1 : 0, 0x000007, writer.finish())
}

function elst(segmentDuration: number, mediaTime: number): Uint8Array {
  const writer = new ByteWriter().u32be(1)
  const v1 = !fits32(segmentDuration) || !fits32(mediaTime)
  if (v1) writer.u64be(segmentDuration).u64be(mediaTime)
  else writer.u32be(segmentDuration).u32be(mediaTime)
  writer.u16be(1).u16be(0) // rate 1.0
  return box('edts', fullBox('elst', v1 ? 1 : 0, 0, writer.finish()))
}

function mdhd(timescale: number, duration: number): Uint8Array {
  const v1 = !fits32(duration)
  const writer = new ByteWriter()
  if (v1) writer.u64be(0).u64be(0).u32be(timescale).u64be(duration)
  else writer.u32be(0).u32be(0).u32be(timescale).u32be(duration)
  writer.u16be(0x55c4).u16be(0) // language "und", pre-defined
  return fullBox('mdhd', v1 ? 1 : 0, 0, writer.finish())
}

function hdlr(handler: string, name: string, manufacturer = ''): Uint8Array {
  const writer = new ByteWriter().u32be(0).ascii(handler)
  writer
    .ascii((manufacturer || '\0\0\0\0').slice(0, 4))
    .u32be(0)
    .u32be(0)
  writer.bytes(utf8(name)).u8(0)
  return fullBox('hdlr', 0, 0, writer.finish())
}

/** Run-length durations: how many samples in a row last how long. */
function stts(samples: Mp4AudioTrack['samples']): Uint8Array {
  const runs: [number, number][] = []
  for (const sample of samples) {
    const last = runs[runs.length - 1]
    if (last && last[1] === sample.duration) last[0] += 1
    else runs.push([1, sample.duration])
  }
  const writer = new ByteWriter().u32be(runs.length)
  for (const [count, delta] of runs) writer.u32be(count).u32be(delta)
  return fullBox('stts', 0, 0, writer.finish())
}

function stsz(samples: Mp4AudioTrack['samples']): Uint8Array {
  const first = samples[0]?.data.length ?? 0
  const constant = samples.every((sample) => sample.data.length === first)
  const writer = new ByteWriter().u32be(constant ? first : 0).u32be(samples.length)
  if (!constant) for (const sample of samples) writer.u32be(sample.data.length)
  return fullBox('stsz', 0, 0, writer.finish())
}

function stsc(chunkSizes: readonly number[]): Uint8Array {
  const entries: [number, number][] = []
  chunkSizes.forEach((count, index) => {
    if (entries[entries.length - 1]?.[1] !== count) entries.push([index + 1, count])
  })
  const writer = new ByteWriter().u32be(entries.length)
  for (const [firstChunk, count] of entries) writer.u32be(firstChunk).u32be(count).u32be(1)
  return fullBox('stsc', 0, 0, writer.finish())
}

function chunkOffsets(offsets: readonly number[], large: boolean): Uint8Array {
  const writer = new ByteWriter().u32be(offsets.length)
  for (const offset of offsets) {
    if (large) writer.u64be(offset)
    else writer.u32be(offset)
  }
  return fullBox(large ? 'co64' : 'stco', 0, 0, writer.finish())
}

/** An ilst item's value: a `data` atom of a type (1 UTF-8, 0 binary, 13 JPEG, 14 PNG). */
function data(type: number, payload: Uint8Array): Uint8Array {
  return box('data', new ByteWriter().u32be(type).u32be(0).finish(), payload)
}

function textItem(name: string, text: string | undefined): Uint8Array | undefined {
  if (text === undefined || text.trim() === '') return undefined
  return box(name, data(1, utf8(text)))
}

/** An iTunes free-form item (`----`), named `name` under `com.apple.iTunes`, holding text. */
function freeformItem(name: string, text: string): Uint8Array {
  return box(
    '----',
    fullBox('mean', 0, 0, latin1('com.apple.iTunes')),
    fullBox('name', 0, 0, latin1(name)),
    data(1, utf8(text)),
  )
}

/** `moov/udta/meta` with the iTunes item list for `tags`. */
function metadata(tags: ExportTags): Uint8Array {
  const track = positive(tags.trackNumber)
  const disc = positive(tags.discNumber)
  const items = [
    textItem('©nam', tags.title),
    textItem('©ART', joinedArtists(tags)),
    textItem('©alb', tags.album),
    track === undefined
      ? undefined
      : box('trkn', data(0, new ByteWriter().u16be(0).u16be(track).u16be(0).u16be(0).finish())),
    disc === undefined
      ? undefined
      : box('disk', data(0, new ByteWriter().u16be(0).u16be(disc).u16be(0).finish())),
    textItem('©day', tags.releaseDate),
    textItem('©lyr', plainLyrics(tags)),
    tags.cover === undefined
      ? undefined
      : box('covr', data(tags.cover.mimeType === 'image/png' ? 14 : 13, tags.cover.data)),
    tags.isrc === undefined ? undefined : freeformItem('ISRC', tags.isrc),
    textItem('©cmt', conversionNote(tags)),
    ...sourceFields(tags).map(([name, value]) => freeformItem(name, value)),
  ].filter((item): item is Uint8Array => item !== undefined)
  return box('udta', fullBox('meta', 0, 0, hdlr('mdir', '', 'appl'), box('ilst', ...items)))
}

/** About a second of audio per chunk: what FFmpeg's MP4 muxer does too. */
function chunkSizes(track: Mp4AudioTrack): number[] {
  const count = track.samples.length
  const average = track.samples.reduce((sum, sample) => sum + sample.duration, 0) / count || 1
  const perChunk = Math.max(1, Math.round(track.timescale / average))
  const sizes: number[] = []
  for (let left = count; left > 0; left -= perChunk) sizes.push(Math.min(perChunk, left))
  return sizes
}

/**
 * An M4A file holding `track` alone, with `tags` when given, as parts of a `Blob`: the header
 * and the movie box, the media data's header, then the samples (left where they are, not
 * copied once more).
 */
export function writeM4a(track: Mp4AudioTrack, tags?: ExportTags): Uint8Array[] {
  const ftyp = box(
    'ftyp',
    new ByteWriter().ascii('M4A ').u32be(0x200).ascii('M4A ').ascii('isom').ascii('mp42').finish(),
  )
  const mediaDuration = track.samples.reduce((sum, sample) => sum + sample.duration, 0)
  const toMovie = (value: number) =>
    Math.round((value * track.movieTimescale) / Math.max(1, track.timescale))
  const start = track.mediaTime ?? 0
  const movieDuration = toMovie(Math.max(0, mediaDuration - start))
  const sizes = chunkSizes(track)
  const dataLength = track.samples.reduce((sum, sample) => sum + sample.data.length, 0)
  const largeData = !fits32(8 + dataLength)

  const moovFor = (offsets: readonly number[], large: boolean) =>
    box(
      'moov',
      mvhd(track.movieTimescale, movieDuration),
      box(
        'trak',
        tkhd(movieDuration),
        ...(track.mediaTime === undefined ? [] : [elst(movieDuration, track.mediaTime)]),
        box(
          'mdia',
          mdhd(track.timescale, mediaDuration),
          hdlr('soun', 'SoundHandler'),
          box(
            'minf',
            fullBox('smhd', 0, 0, new ByteWriter().u16be(0).u16be(0).finish()),
            box(
              'dinf',
              fullBox('dref', 0, 0, new ByteWriter().u32be(1).finish(), fullBox('url ', 0, 1)),
            ),
            box(
              'stbl',
              fullBox('stsd', 0, 0, new ByteWriter().u32be(1).finish(), track.sampleEntry),
              stts(track.samples),
              stsc(sizes),
              stsz(track.samples),
              chunkOffsets(offsets, large),
            ),
          ),
        ),
      ),
      ...(tags === undefined ? [] : [metadata(tags)]),
    )

  // The chunk offsets depend on the movie box's size, which depends on their width only: 32
  // bits (stco), or 64 (co64) when the file passes 4 GiB.
  const zeros = sizes.map(() => 0)
  const estimate = ftyp.length + moovFor(zeros, false).length + 4 * sizes.length + 16 + dataLength
  const large = !fits32(estimate)
  const headerBytes = largeData ? 16 : 8
  const offsets: number[] = []
  let at = ftyp.length + moovFor(zeros, large).length + headerBytes
  let sample = 0
  for (const count of sizes) {
    offsets.push(at)
    for (let i = 0; i < count; i++) at += track.samples[sample++]?.data.length ?? 0
  }
  const moov = moovFor(offsets, large)
  const mdatHeader = largeData
    ? new ByteWriter()
        .u32be(1)
        .ascii('mdat')
        .u64be(16 + dataLength)
        .finish()
    : new ByteWriter()
        .u32be(8 + dataLength)
        .ascii('mdat')
        .finish()
  return [ftyp, moov, mdatHeader, ...track.samples.map((item) => item.data)]
}
