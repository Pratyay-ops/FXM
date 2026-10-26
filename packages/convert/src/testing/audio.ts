/**
 * Audio files that tests generate themselves, never real recordings: sine waves and silence in
 * WAV and MP3 (both decodable), and files with the real structure of FLAC, Ogg Opus, Ogg
 * Vorbis, M4A (plain and fragmented) and YouTube's itag 18 (a video with an AAC track), whose
 * audio payload is filler: the tag writers and the MP4 code never decode it.
 *
 * @module
 */

import { ByteWriter, concat, oggCrc, utf8 } from '../bytes'
import { box, fullBox } from '../mp4/boxes'
import type { Mp4AudioTrack, Mp4Sample } from '../mp4/demux'
import { writeM4a } from '../mp4/write'

/** Options for {@link sineWav}. */
export interface SineOptions {
  readonly seconds?: number
  readonly sampleRate?: number
  readonly channels?: number
  readonly bitDepth?: 16 | 24
  readonly frequency?: number
}

/** A WAV file of a sine wave (default: 0.5 s, 44.1 kHz, stereo, 16-bit, 440 Hz). */
export function sineWav(options: SineOptions = {}): Uint8Array {
  const {
    seconds = 0.5,
    sampleRate = 44100,
    channels = 2,
    bitDepth = 16,
    frequency = 440,
  } = options
  const frames = Math.round(seconds * sampleRate)
  const bytesPerSample = bitDepth / 8
  const data = new Uint8Array(frames * channels * bytesPerSample)
  const view = new DataView(data.buffer)
  const peak = bitDepth === 16 ? 12_000 : 3_000_000
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * peak)
    for (let channel = 0; channel < channels; channel++) {
      const at = (i * channels + channel) * bytesPerSample
      if (bitDepth === 16) view.setInt16(at, value, true)
      else {
        data[at] = value & 0xff
        data[at + 1] = (value >> 8) & 0xff
        data[at + 2] = (value >> 16) & 0xff
      }
    }
  }
  const fmt = new ByteWriter()
    .u16le(1) // PCM
    .u16le(channels)
    .u32le(sampleRate)
    .u32le(sampleRate * channels * bytesPerSample)
    .u16le(channels * bytesPerSample)
    .u16le(bitDepth)
    .finish()
  return riff([chunk('fmt ', fmt), chunk('data', data)])
}

function chunk(id: string, data: Uint8Array): Uint8Array {
  const writer = new ByteWriter().ascii(id).u32le(data.length).bytes(data)
  if (data.length % 2) writer.u8(0)
  return writer.finish()
}

/** A RIFF WAVE file of the given chunks. */
export function riff(chunks: readonly Uint8Array[]): Uint8Array {
  const body = concat([utf8('WAVE'), ...chunks])
  return concat([new ByteWriter().ascii('RIFF').u32le(body.length).finish(), body])
}

/** A WAV chunk, for tests that build their own files. */
export { chunk as riffChunk }

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo, no padding: 417 bytes a frame. */
const MP3_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x00]
const MP3_FRAME_BYTES = 417

/** Options for {@link mp3File}. */
export interface Mp3Options {
  /** Frames of silence (default 20, about half a second). */
  readonly frames?: number
  /** Bytes to put before the frames, e.g. an ID3v2 tag. */
  readonly prefix?: Uint8Array
  /** An ID3v1 tag at the end. */
  readonly id3v1Title?: string
}

/**
 * An MP3 file of silent frames: zero side information and no Huffman data decode as silence in
 * any decoder.
 */
export function mp3File(options: Mp3Options = {}): Uint8Array {
  const frame = new Uint8Array(MP3_FRAME_BYTES)
  frame.set(MP3_FRAME_HEADER)
  const frames = Array.from({ length: options.frames ?? 20 }, () => frame)
  const parts = [options.prefix ?? new Uint8Array(), ...frames]
  if (options.id3v1Title !== undefined) {
    const tag = new Uint8Array(128)
    tag.set(utf8('TAG'))
    tag.set(utf8(options.id3v1Title).subarray(0, 30), 3)
    parts.push(tag)
  }
  return concat(parts)
}

/** Filler that stands in for encoded audio. */
export function filler(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length)
  let value = seed
  for (let i = 0; i < length; i++) {
    value = (value * 1103515245 + 12345) >>> 0
    bytes[i] = value >>> 24
  }
  return bytes
}

/** A Vorbis comment list (vendor, then NAME=value entries), little-endian lengths. */
export function vorbisComments(vendor: string, fields: readonly [string, string][]): Uint8Array {
  const writer = new ByteWriter()
    .u32le(utf8(vendor).length)
    .bytes(utf8(vendor))
    .u32le(fields.length)
  for (const [name, value] of fields) {
    const entry = utf8(`${name}=${value}`)
    writer.u32le(entry.length).bytes(entry)
  }
  return writer.finish()
}

/** Options for {@link flacFile}. */
export interface FlacOptions {
  readonly vendor?: string
  readonly comments?: readonly [string, string][]
  /** A PICTURE block's body. */
  readonly picture?: Uint8Array
  /** A SEEKTABLE block (kept by the tag writer). */
  readonly seekTable?: boolean
  /** Bytes standing in for the frames. */
  readonly frames?: Uint8Array
  /** Bytes before the stream, e.g. an ID3v2 tag. */
  readonly prefix?: Uint8Array
}

function flacBlock(type: number, body: Uint8Array, last: boolean): Uint8Array {
  return new ByteWriter()
    .u8((last ? 0x80 : 0) | type)
    .u24be(body.length)
    .bytes(body)
    .finish()
}

/** A FLAC stream: real metadata blocks, filler frames. */
export function flacFile(options: FlacOptions = {}): Uint8Array {
  // STREAMINFO: 4096-sample blocks, 44.1 kHz, stereo, 16 bits, 22050 samples, no MD5.
  const info = new ByteWriter()
    .u16be(4096)
    .u16be(4096)
    .u24be(0)
    .u24be(0)
    .bytes(new Uint8Array([0x0a, 0xc4, 0x42, 0xf0, 0x00, 0x00, 0x56, 0x22]))
    .bytes(new Uint8Array(16))
    .finish()
  const blocks: [number, Uint8Array][] = [[0, info]]
  if (options.seekTable) blocks.push([3, new Uint8Array(18)])
  blocks.push([
    4,
    vorbisComments(options.vendor ?? 'reference libFLAC 1.4.3', options.comments ?? []),
  ])
  if (options.picture) blocks.push([6, options.picture])
  blocks.push([1, new Uint8Array(64)])
  const encoded = blocks.map(([type, body], index) =>
    flacBlock(type, body, index === blocks.length - 1),
  )
  return concat([
    options.prefix ?? new Uint8Array(),
    utf8('fLaC'),
    ...encoded,
    options.frames ?? concat([new Uint8Array([0xff, 0xf8]), filler(2000)]),
  ])
}

/** One Ogg page, CRC included. */
export function oggPage(options: {
  serial: number
  sequence: number
  granule: number
  flags?: number
  segments: readonly number[]
  data: Uint8Array
}): Uint8Array {
  const page = new ByteWriter()
    .ascii('OggS')
    .u8(0)
    .u8(options.flags ?? 0)
    .u64le(options.granule)
    .u32le(options.serial)
    .u32le(options.sequence)
    .u32le(0)
    .u8(options.segments.length)
  for (const value of options.segments) page.u8(value)
  const bytes = page.bytes(options.data).finish()
  const crc = oggCrc(bytes)
  bytes[22] = crc & 0xff
  bytes[23] = (crc >>> 8) & 0xff
  bytes[24] = (crc >>> 16) & 0xff
  bytes[25] = (crc >>> 24) & 0xff
  return bytes
}

/** The lacing values of one packet. */
function lacing(length: number): number[] {
  const values: number[] = []
  let left = length
  while (left >= 255) {
    values.push(255)
    left -= 255
  }
  values.push(left)
  return values
}

/** Options for the Ogg files. */
export interface OggOptions {
  readonly vendor?: string
  readonly comments?: readonly [string, string][]
  /** Audio packets (default 12 short filler packets). */
  readonly packets?: readonly Uint8Array[]
  /** Audio packets per page (default 4). */
  readonly packetsPerPage?: number
  readonly serial?: number
}

function oggFile(headers: readonly Uint8Array[], options: OggOptions, samplesPerPacket: number) {
  const serial = options.serial ?? 0x4f584d46
  const packets =
    options.packets ?? Array.from({ length: 12 }, (_, index) => filler(40 + index, index + 1))
  const perPage = options.packetsPerPage ?? 4
  const pages: Uint8Array[] = []
  let sequence = 0
  // The identification header alone on the first page; the others on the next page.
  const [id, ...rest] = headers
  pages.push(
    oggPage({
      serial,
      sequence: sequence++,
      granule: 0,
      flags: 0x02,
      segments: lacing(id?.length ?? 0),
      data: id ?? new Uint8Array(),
    }),
  )
  pages.push(
    oggPage({
      serial,
      sequence: sequence++,
      granule: 0,
      segments: rest.flatMap((packet) => lacing(packet.length)),
      data: concat(rest),
    }),
  )
  let granule = 0
  for (let first = 0; first < packets.length; first += perPage) {
    const group = packets.slice(first, first + perPage)
    granule += group.length * samplesPerPacket
    pages.push(
      oggPage({
        serial,
        sequence: sequence++,
        granule,
        flags: first + perPage >= packets.length ? 0x04 : 0,
        segments: group.flatMap((packet) => lacing(packet.length)),
        data: concat(group),
      }),
    )
  }
  return concat(pages)
}

/** An Ogg Opus file: real headers (RFC 7845), filler audio packets of 20 ms. */
export function oggOpusFile(options: OggOptions = {}): Uint8Array {
  const head = new ByteWriter()
    .ascii('OpusHead')
    .u8(1)
    .u8(2) // channels
    .u16le(312) // pre-skip
    .u32le(48000)
    .u16le(0)
    .u8(0)
    .finish()
  const tags = concat([
    utf8('OpusTags'),
    vorbisComments(options.vendor ?? 'libopus 1.6.1', options.comments ?? []),
  ])
  return oggFile([head, tags], options, 960)
}

/** An Ogg Vorbis file: real identification and comment headers, a filler setup header. */
export function oggVorbisFile(options: OggOptions = {}): Uint8Array {
  const id = new ByteWriter()
    .u8(1)
    .ascii('vorbis')
    .u32le(0)
    .u8(2)
    .u32le(44100)
    .u32le(0)
    .u32le(128000)
    .u32le(0)
    .u8(0xb8)
    .u8(1)
    .finish()
  const comments = concat([
    new Uint8Array([3]),
    utf8('vorbis'),
    vorbisComments(
      options.vendor ?? 'Xiph.Org libVorbis I 20200704 (Reducing Environment)',
      options.comments ?? [],
    ),
    new Uint8Array([1]),
  ])
  const setup = concat([new Uint8Array([5]), utf8('vorbis'), filler(300, 7)])
  return oggFile([id, comments, setup], options, 1024)
}

/**
 * An `mp4a` sample entry for AAC-LC, 44.1 kHz stereo, with its `esds` (the decoder
 * configuration a player needs).
 */
export function aacSampleEntry(): Uint8Array {
  const decoderSpecific = new Uint8Array([0x05, 0x02, 0x12, 0x10]) // AudioSpecificConfig
  const decoderConfig = concat([
    new Uint8Array([0x04, 13 + decoderSpecific.length, 0x40, 0x15, 0x00, 0x18, 0x00]),
    new ByteWriter().u32be(128000).u32be(128000).finish(),
    decoderSpecific,
  ])
  const descriptor = concat([
    new Uint8Array([0x03, 3 + decoderConfig.length + 3, 0x00, 0x01, 0x00]),
    decoderConfig,
    new Uint8Array([0x06, 0x01, 0x02]),
  ])
  return box(
    'mp4a',
    new ByteWriter()
      .bytes(new Uint8Array(6))
      .u16be(1) // data reference
      .u32be(0)
      .u32be(0)
      .u16be(2) // channels
      .u16be(16) // bits per sample
      .u16be(0)
      .u16be(0)
      .u32be(44100 * 65536)
      .finish(),
    fullBox('esds', 0, 0, descriptor),
  )
}

/** AAC frames standing in for audio: 1024 samples each at 44.1 kHz. */
export function aacSamples(count = 30): Mp4Sample[] {
  return Array.from({ length: count }, (_, index) => ({
    data: filler(150 + (index % 7) * 9, index + 3),
    duration: 1024,
  }))
}

/** A plain M4A file of filler AAC frames, through FXM's own writer. */
export function m4aFile(options: { samples?: Mp4Sample[]; mediaTime?: number } = {}): Uint8Array {
  const track: Mp4AudioTrack = {
    type: 'mp4a',
    sampleEntry: aacSampleEntry(),
    timescale: 44100,
    movieTimescale: 1000,
    samples: options.samples ?? aacSamples(),
    ...(options.mediaTime === undefined ? {} : { mediaTime: options.mediaTime }),
  }
  return concat(writeM4a(track))
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

function trackHeader(id: number, duration: number, video: boolean): Uint8Array {
  const writer = new ByteWriter().u32be(0).u32be(0).u32be(id).u32be(0).u32be(duration)
  writer
    .u32be(0)
    .u32be(0)
    .u16be(0)
    .u16be(0)
    .u16be(video ? 0 : 0x0100)
    .u16be(0)
  for (const value of MATRIX) writer.u32be(value)
  writer.u32be(video ? 640 << 16 : 0).u32be(video ? 360 << 16 : 0)
  return fullBox('tkhd', 0, 3, writer.finish())
}

function movieHeader(timescale: number, duration: number, nextTrack: number): Uint8Array {
  const writer = new ByteWriter().u32be(0).u32be(0).u32be(timescale).u32be(duration)
  writer.u32be(0x00010000).u16be(0x0100).u16be(0).u32be(0).u32be(0)
  for (const value of MATRIX) writer.u32be(value)
  for (let i = 0; i < 6; i++) writer.u32be(0)
  return fullBox('mvhd', 0, 0, writer.u32be(nextTrack).finish())
}

function mediaHeader(timescale: number, duration: number): Uint8Array {
  return fullBox(
    'mdhd',
    0,
    0,
    new ByteWriter()
      .u32be(0)
      .u32be(0)
      .u32be(timescale)
      .u32be(duration)
      .u16be(0x55c4)
      .u16be(0)
      .finish(),
  )
}

function handler(type: string): Uint8Array {
  return fullBox(
    'hdlr',
    0,
    0,
    new ByteWriter().u32be(0).ascii(type).u32be(0).u32be(0).u32be(0).u8(0).finish(),
  )
}

function dataInformation(): Uint8Array {
  return box(
    'dinf',
    fullBox('dref', 0, 0, new ByteWriter().u32be(1).finish(), fullBox('url ', 0, 1)),
  )
}

/** A minimal `avc1` sample entry (360p) with a placeholder `avcC`. */
function videoSampleEntry(): Uint8Array {
  const writer = new ByteWriter().bytes(new Uint8Array(6)).u16be(1).u16be(0).u16be(0)
  writer.u32be(0).u32be(0).u32be(0).u16be(640).u16be(360).u32be(0x00480000).u32be(0x00480000)
  writer.u32be(0).u16be(1).bytes(new Uint8Array(32)).u16be(0x18).u16be(0xffff)
  const avcC = box(
    'avcC',
    new Uint8Array([
      1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, 0x01, 0x00, 0x04, 0x68,
      0xce, 0x3c, 0x80,
    ]),
  )
  return box('avc1', writer.finish(), avcC)
}

function sampleTable(
  entry: Uint8Array,
  samples: readonly Mp4Sample[],
  offsets: readonly number[],
  perChunk: number,
  sync: boolean,
): Uint8Array {
  const stts = new ByteWriter()
    .u32be(1)
    .u32be(samples.length)
    .u32be(samples[0]?.duration ?? 0)
    .finish()
  const stsc = new ByteWriter().u32be(1).u32be(1).u32be(perChunk).u32be(1).finish()
  const stsz = new ByteWriter().u32be(0).u32be(samples.length)
  for (const sample of samples) stsz.u32be(sample.data.length)
  const stco = new ByteWriter().u32be(offsets.length)
  for (const offset of offsets) stco.u32be(offset)
  const boxes = [
    fullBox('stsd', 0, 0, new ByteWriter().u32be(1).finish(), entry),
    fullBox('stts', 0, 0, stts),
    fullBox('stsc', 0, 0, stsc),
    fullBox('stsz', 0, 0, stsz.finish()),
    fullBox('stco', 0, 0, stco.finish()),
  ]
  if (sync) boxes.push(fullBox('stss', 0, 0, new ByteWriter().u32be(1).u32be(1).finish()))
  return box('stbl', ...boxes)
}

/**
 * An MP4 like YouTube's itag 18: a 360p video track and an AAC track, interleaved one chunk
 * each, the movie box first, an edit list on the audio for the encoder's priming.
 */
export function itag18File(
  options: { audio?: Mp4Sample[]; videoFrames?: number } = {},
): Uint8Array {
  const audio = options.audio ?? aacSamples(20)
  const video = Array.from({ length: options.videoFrames ?? 10 }, (_, index) => ({
    data: filler(800 + index * 13, 100 + index),
    duration: 3000,
  }))
  const audioDuration = audio.reduce((sum, sample) => sum + sample.duration, 0)
  const moovFor = (videoOffset: number, audioOffset: number) =>
    box(
      'moov',
      movieHeader(1000, Math.round((audioDuration / 44100) * 1000), 3),
      box(
        'trak',
        trackHeader(1, 1000, true),
        box(
          'mdia',
          mediaHeader(90000, 30000),
          handler('vide'),
          box(
            'minf',
            fullBox('vmhd', 0, 1, new Uint8Array(8)),
            dataInformation(),
            sampleTable(videoSampleEntry(), video, [videoOffset], video.length, true),
          ),
        ),
      ),
      box(
        'trak',
        trackHeader(2, Math.round((audioDuration / 44100) * 1000), false),
        box(
          'edts',
          fullBox(
            'elst',
            0,
            0,
            new ByteWriter()
              .u32be(1)
              .u32be(Math.round(((audioDuration - 1024) / 44100) * 1000))
              .u32be(1024)
              .u16be(1)
              .u16be(0)
              .finish(),
          ),
        ),
        box(
          'mdia',
          mediaHeader(44100, audioDuration),
          handler('soun'),
          box(
            'minf',
            fullBox('smhd', 0, 0, new Uint8Array(4)),
            dataInformation(),
            sampleTable(aacSampleEntry(), audio, [audioOffset], audio.length, false),
          ),
        ),
      ),
    )
  const ftyp = box(
    'ftyp',
    new ByteWriter().ascii('mp42').u32be(0).ascii('isom').ascii('mp42').finish(),
  )
  const videoBytes = concat(video.map((frame) => frame.data))
  const audioBytes = concat(audio.map((sample) => sample.data))
  const moovLength = moovFor(0, 0).length
  const videoOffset = ftyp.length + moovLength + 8
  const moov = moovFor(videoOffset, videoOffset + videoBytes.length)
  return concat([ftyp, moov, box('mdat', videoBytes, audioBytes)])
}

/**
 * A fragmented M4A like YouTube's itag 140: an empty sample table in the movie box, then one
 * movie fragment (moof + mdat) per few samples.
 */
export function fragmentedM4aFile(
  options: { samples?: Mp4Sample[]; perFragment?: number } = {},
): Uint8Array {
  const samples = options.samples ?? aacSamples(24)
  const perFragment = options.perFragment ?? 8
  const empty = box(
    'stbl',
    fullBox('stsd', 0, 0, new ByteWriter().u32be(1).finish(), aacSampleEntry()),
    fullBox('stts', 0, 0, new ByteWriter().u32be(0).finish()),
    fullBox('stsc', 0, 0, new ByteWriter().u32be(0).finish()),
    fullBox('stsz', 0, 0, new ByteWriter().u32be(0).u32be(0).finish()),
    fullBox('stco', 0, 0, new ByteWriter().u32be(0).finish()),
  )
  const moov = box(
    'moov',
    movieHeader(1000, 0, 2),
    box(
      'trak',
      trackHeader(1, 0, false),
      box(
        'mdia',
        mediaHeader(44100, 0),
        handler('soun'),
        box('minf', fullBox('smhd', 0, 0, new Uint8Array(4)), dataInformation(), empty),
      ),
    ),
    box(
      'mvex',
      fullBox('trex', 0, 0, new ByteWriter().u32be(1).u32be(1).u32be(0).u32be(0).u32be(0).finish()),
    ),
  )
  const ftyp = box(
    'ftyp',
    new ByteWriter().ascii('dash').u32be(0).ascii('iso6').ascii('mp41').finish(),
  )
  const fragments: Uint8Array[] = []
  let decodeTime = 0
  for (let first = 0, sequence = 1; first < samples.length; first += perFragment, sequence++) {
    const group = samples.slice(first, first + perFragment)
    const moofFor = (dataOffset: number) => {
      const trun = new ByteWriter().u32be(group.length).u32be(dataOffset)
      for (const sample of group) trun.u32be(sample.duration).u32be(sample.data.length)
      return box(
        'moof',
        fullBox('mfhd', 0, 0, new ByteWriter().u32be(sequence).finish()),
        box(
          'traf',
          fullBox('tfhd', 0, 0x020000, new ByteWriter().u32be(1).finish()), // default-base-is-moof
          fullBox('tfdt', 1, 0, new ByteWriter().u64be(decodeTime).finish()),
          fullBox('trun', 0, 0x000301, trun.finish()), // data offset, durations, sizes
        ),
      )
    }
    const moofLength = moofFor(0).length
    fragments.push(moofFor(moofLength + 8), box('mdat', ...group.map((sample) => sample.data)))
    decodeTime += group.reduce((sum, sample) => sum + sample.duration, 0)
  }
  return concat([ftyp, moov, ...fragments])
}
