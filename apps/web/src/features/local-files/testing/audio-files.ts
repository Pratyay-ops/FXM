/**
 * Tiny, valid audio files built in code for tests: WAV, FLAC, MP3, M4A (ALAC or AAC) and Ogg
 * Opus, with tags and an optional cover, plus solid-colour PNGs for covers. Every file holds
 * silence or no audio at all, so no recording (and no copyright) is involved, and the bytes are
 * spelled out here instead of committed as binary fixtures.
 *
 * The WAV, FLAC and MP3 files are playable (silence): the end-to-end test plays them in a real
 * browser. The M4A and Opus files carry headers and tags only, enough for the tag reader.
 *
 * @module
 */

/** Tags to write. Every field is optional. */
export interface TestTags {
  title?: string
  /** One or more artists; several are written as separate values where the format allows. */
  artists?: string[]
  albumArtist?: string
  album?: string
  track?: number
  trackTotal?: number
  disc?: number
  /** e.g. `2013` or `2013-05-17`. */
  date?: string
  isrc?: string
  compilation?: boolean
}

/** A cover to embed. */
export interface TestPicture {
  data: Uint8Array
  /** e.g. `image/png`. */
  mime: string
}

const encoder = new TextEncoder()

function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff)
}

/** The parts, one after another. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16be(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff)
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  )
}

function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

function u32le(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  )
}

function u64le(value: number): Uint8Array {
  return concat(u32le(value >>> 0), u32le(Math.floor(value / 2 ** 32)))
}

/** FLAC's CRC-8 of a frame header: polynomial x^8 + x^2 + x + 1, no reflection. */
function crc8(bytes: Uint8Array): number {
  let value = 0
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++)
      value = value & 0x80 ? ((value << 1) ^ 0x07) & 0xff : (value << 1) & 0xff
  }
  return value
}

/** FLAC's CRC-16 of a frame: polynomial x^16 + x^15 + x^2 + 1, no reflection. */
function crc16(bytes: Uint8Array): number {
  let value = 0
  for (const byte of bytes) {
    value ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x8000 ? ((value << 1) ^ 0x8005) & 0xffff : (value << 1) & 0xffff
    }
  }
  return value
}

/** Ogg's CRC-32 of a page: polynomial 0x04C11DB7, no reflection. */
function oggCrc(bytes: Uint8Array): number {
  let value = 0
  for (const byte of bytes) {
    value = (value ^ (byte << 24)) >>> 0
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1) >>> 0
    }
  }
  return value
}

/** CRC-32 as PNG and zlib use (reflected, polynomial 0xEDB88320). */
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

// --- Covers --------------------------------------------------------------------------------

/** A solid-colour PNG of `size` × `size` pixels: a real image browsers decode. */
export function pngImage(rgb: [number, number, number], size = 4): Uint8Array<ArrayBuffer> {
  const row = concat(Uint8Array.of(0), ...Array.from({ length: size }, () => Uint8Array.from(rgb)))
  const raw = concat(...Array.from({ length: size }, () => row))
  // zlib with one stored (uncompressed) block, then the Adler-32 of the data.
  let a = 1
  let b = 0
  for (const byte of raw) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  const zlib = concat(
    Uint8Array.of(0x78, 0x01, 0x01),
    u16le(raw.length),
    u16le(~raw.length & 0xffff),
    raw,
    u32be(((b << 16) | a) >>> 0),
  )
  const chunk = (type: string, data: Uint8Array) =>
    concat(u32be(data.length), latin1(type), data, u32be(crc32(concat(latin1(type), data))))
  const header = concat(u32be(size), u32be(size), Uint8Array.of(8, 2, 0, 0, 0))
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  )
}

// --- ID3v2.4 (MP3 and WAV) -----------------------------------------------------------------

function syncsafe(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  )
}

function id3Frame(id: string, data: Uint8Array): Uint8Array {
  return concat(latin1(id), syncsafe(data.length), Uint8Array.of(0, 0), data)
}

function id3Text(id: string, values: readonly string[]): Uint8Array {
  // Encoding 3 is UTF-8; ID3v2.4 separates several values with NUL.
  return id3Frame(id, concat(Uint8Array.of(3), utf8(values.join('\u0000'))))
}

/** An ID3v2.4 tag. */
export function id3Tag(tags: TestTags, picture?: TestPicture): Uint8Array {
  const frames: Uint8Array[] = []
  if (tags.title !== undefined) frames.push(id3Text('TIT2', [tags.title]))
  if (tags.artists !== undefined) frames.push(id3Text('TPE1', tags.artists))
  if (tags.albumArtist !== undefined) frames.push(id3Text('TPE2', [tags.albumArtist]))
  if (tags.album !== undefined) frames.push(id3Text('TALB', [tags.album]))
  if (tags.track !== undefined) {
    const track =
      tags.trackTotal === undefined ? `${tags.track}` : `${tags.track}/${tags.trackTotal}`
    frames.push(id3Text('TRCK', [track]))
  }
  if (tags.disc !== undefined) frames.push(id3Text('TPOS', [`${tags.disc}`]))
  if (tags.date !== undefined) frames.push(id3Text('TDRC', [tags.date]))
  if (tags.isrc !== undefined) frames.push(id3Text('TSRC', [tags.isrc]))
  if (tags.compilation === true) frames.push(id3Text('TCMP', ['1']))
  if (picture !== undefined) {
    // Encoding, MIME type, picture type 3 (front cover), empty description, the image.
    frames.push(
      id3Frame(
        'APIC',
        concat(Uint8Array.of(3), latin1(picture.mime), Uint8Array.of(0, 3, 0), picture.data),
      ),
    )
  }
  const body = concat(...frames)
  return concat(latin1('ID3'), Uint8Array.of(4, 0, 0), syncsafe(body.length), body)
}

// --- WAV -----------------------------------------------------------------------------------

/** Options for {@link wavFile}. */
export interface WavOptions {
  tags?: TestTags
  picture?: TestPicture
  seconds?: number
  sampleRate?: number
  bitsPerSample?: 16 | 24 | 32
  channels?: 1 | 2
  /** 32-bit float samples (format tag 3, or its SubFormat when extensible) instead of integers. */
  float?: boolean
  /**
   * Writes the header as WAVE_FORMAT_EXTENSIBLE (format tag 0xFFFE, with the format in a
   * SubFormat GUID), as ffmpeg does for anything above 16-bit or 48 kHz.
   */
  extensible?: boolean
  /** With `extensible`: the bits of each sample that hold audio. Default: all of them. */
  validBits?: number
  /** Chunks written before the `fmt ` chunk, e.g. `JUNK` padding. */
  leading?: { id: string; data: Uint8Array }[]
}

function riffChunk(id: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 1 ? concat(data, Uint8Array.of(0)) : data
  return concat(latin1(id), u32le(data.length), padded)
}

/**
 * The body of a WAV's `fmt ` chunk: WAVEFORMAT, or WAVEFORMATEXTENSIBLE with `extensible`, whose
 * SubFormat is the format tag in the GUID `xxxxxxxx-0000-0010-8000-00aa00389b71`.
 */
export function wavFormatChunk({
  sampleRate = 8000,
  bitsPerSample = 16,
  channels = 1,
  float = false,
  extensible = false,
  validBits = bitsPerSample,
}: Pick<
  WavOptions,
  'sampleRate' | 'bitsPerSample' | 'channels' | 'float' | 'extensible' | 'validBits'
> = {}): Uint8Array<ArrayBuffer> {
  const blockAlign = (channels * bitsPerSample) / 8
  const tag = float ? 3 : 1
  const base = concat(
    u16le(extensible ? 0xfffe : tag),
    u16le(channels),
    u32le(sampleRate),
    u32le(sampleRate * blockAlign),
    u16le(blockAlign),
    u16le(bitsPerSample),
  )
  if (!extensible) return base
  // cbSize, valid bits, the speaker mask (front centre, or front left and right), SubFormat.
  const subFormat = concat(
    u32le(tag),
    Uint8Array.of(0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71),
  )
  return concat(base, u16le(22), u16le(validBits), u32le(channels === 1 ? 0x4 : 0x3), subFormat)
}

/** A WAV of silence, with an `id3 ` chunk when it has tags. */
export function wavFile({
  tags,
  picture,
  seconds = 1,
  sampleRate = 8000,
  bitsPerSample = 16,
  channels = 1,
  float = false,
  extensible = false,
  validBits = bitsPerSample,
  leading = [],
}: WavOptions = {}): Uint8Array<ArrayBuffer> {
  const blockAlign = (channels * bitsPerSample) / 8
  const format = wavFormatChunk({
    sampleRate,
    bitsPerSample,
    channels,
    float,
    extensible,
    validBits,
  })
  const data = new Uint8Array(Math.round(seconds * sampleRate) * blockAlign)
  const chunks = [
    ...leading.map((chunk) => riffChunk(chunk.id, chunk.data)),
    riffChunk('fmt ', format),
    riffChunk('data', data),
  ]
  if (tags !== undefined || picture !== undefined)
    chunks.push(riffChunk('id3 ', id3Tag(tags ?? {}, picture)))
  const body = concat(latin1('WAVE'), ...chunks)
  return concat(latin1('RIFF'), u32le(body.length), body)
}

// --- MP3 -----------------------------------------------------------------------------------

/** Bytes of one MPEG-1 Layer III frame at 128 kbps and 44.1 kHz, without padding. */
const MP3_FRAME_BYTES = 417

/** An MP3 of silent frames (128 kbps, 44.1 kHz, mono), with an ID3v2.4 tag. */
export function mp3File({
  tags = {},
  picture,
  frames = 40,
}: {
  tags?: TestTags
  picture?: TestPicture
  /** About 26 ms each. */
  frames?: number
} = {}): Uint8Array<ArrayBuffer> {
  // Sync, MPEG-1, Layer III, no CRC; 128 kbps, 44.1 kHz; mono, original. All-zero side info and
  // main data decode to silence.
  const frame = new Uint8Array(MP3_FRAME_BYTES)
  frame.set([0xff, 0xfb, 0x90, 0xc4])
  return concat(id3Tag(tags, picture), ...Array.from({ length: frames }, () => frame))
}

// --- FLAC ----------------------------------------------------------------------------------

/** Options for {@link flacFile}. */
export interface FlacOptions {
  tags?: TestTags
  picture?: TestPicture
  /** Audio frames of 4096 samples each (about 0.09 s at 44.1 kHz). */
  frames?: number
  bitsPerSample?: 16 | 24
}

function flacBlock(type: number, data: Uint8Array, last: boolean): Uint8Array {
  return concat(Uint8Array.of((last ? 0x80 : 0) | type), u32be(data.length).subarray(1), data)
}

function vorbisComments(tags: TestTags): [string, string][] {
  const comments: [string, string][] = []
  if (tags.title !== undefined) comments.push(['TITLE', tags.title])
  for (const artist of tags.artists ?? []) comments.push(['ARTIST', artist])
  if (tags.albumArtist !== undefined) comments.push(['ALBUMARTIST', tags.albumArtist])
  if (tags.album !== undefined) comments.push(['ALBUM', tags.album])
  if (tags.track !== undefined) comments.push(['TRACKNUMBER', `${tags.track}`])
  if (tags.trackTotal !== undefined) comments.push(['TRACKTOTAL', `${tags.trackTotal}`])
  if (tags.disc !== undefined) comments.push(['DISCNUMBER', `${tags.disc}`])
  if (tags.date !== undefined) comments.push(['DATE', tags.date])
  if (tags.isrc !== undefined) comments.push(['ISRC', tags.isrc])
  if (tags.compilation === true) comments.push(['COMPILATION', '1'])
  return comments
}

/** A Vorbis comment block's body (FLAC and Ogg). */
function vorbisCommentBody(tags: TestTags): Uint8Array {
  const vendor = utf8('FXM tests')
  const comments = vorbisComments(tags).map(([key, value]) => utf8(`${key}=${value}`))
  return concat(
    u32le(vendor.length),
    vendor,
    u32le(comments.length),
    ...comments.flatMap((comment) => [u32le(comment.length), comment]),
  )
}

/**
 * A FLAC stream of silence: 44.1 kHz, mono, 4096-sample frames whose single subframe is a
 * constant 0, with CRCs, so decoders play it.
 */
export function flacFile({
  tags = {},
  picture,
  frames = 11,
  bitsPerSample = 16,
}: FlacOptions = {}): Uint8Array<ArrayBuffer> {
  const sampleRate = 44_100
  const blockSize = 4096
  const totalSamples = frames * blockSize
  // STREAMINFO: block sizes, frame sizes (0: unknown), then 20 bits of sample rate, 3 of
  // channels - 1, 5 of bits per sample - 1 and 36 of total samples, then an empty MD5.
  const info = new Uint8Array(34)
  info.set(u16be(blockSize), 0)
  info.set(u16be(blockSize), 2)
  const packed = [
    (sampleRate >>> 12) & 0xff,
    (sampleRate >>> 4) & 0xff,
    ((sampleRate & 0x0f) << 4) | (0 << 1) | (((bitsPerSample - 1) >>> 4) & 0x01),
    (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0x0f),
  ]
  info.set(packed, 10)
  info.set(u32be(totalSamples >>> 0), 14)
  const blocks = [
    flacBlock(0, info, false),
    flacBlock(4, vorbisCommentBody(tags), picture === undefined),
  ]
  if (picture !== undefined) {
    const mime = latin1(picture.mime)
    const body = concat(
      u32be(3),
      u32be(mime.length),
      mime,
      u32be(0),
      u32be(4),
      u32be(4),
      u32be(24),
      u32be(0),
      u32be(picture.data.length),
      picture.data,
    )
    blocks.push(flacBlock(6, body, true))
  }
  const sizeCode = bitsPerSample === 16 ? 0b100 : 0b110
  const audio = Array.from({ length: frames }, (_, index) => {
    // Sync and fixed block size; 4096 samples (0b1100), 44.1 kHz (0b1001); mono and the sample
    // size; the frame number, UTF-8 coded (one byte below 128); then CRC-8 of the header.
    const header = Uint8Array.of(0xff, 0xf8, 0xc9, (0b0000 << 4) | (sizeCode << 1), index)
    const withCrc8 = concat(header, Uint8Array.of(crc8(header)))
    // One CONSTANT subframe (type 000000) holding a single sample of 0, byte-aligned.
    const subframe = new Uint8Array(1 + bitsPerSample / 8)
    const frame = concat(withCrc8, subframe)
    return concat(frame, u16be(crc16(frame)))
  })
  return concat(latin1('fLaC'), ...blocks, ...audio)
}

// --- M4A -----------------------------------------------------------------------------------

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(...children)
  return concat(u32be(body.length + 8), latin1(type), body)
}

function fullBox(type: string, flags: number, ...children: Uint8Array[]): Uint8Array {
  return box(type, u32be(flags & 0x00ffffff), ...children)
}

function ilstItem(type: string, dataType: number, value: Uint8Array): Uint8Array {
  // `data`: a type set (0) and a 24-bit well-known type, a locale (0), the value.
  return box(type, box('data', u32be(dataType), u32be(0), value))
}

/**
 * An M4A file with headers, iTunes tags and no audio samples: an `alac` or `mp4a` (AAC) sample
 * entry, so the tag reader sees the codec, sample rate and length.
 */
export function m4aFile({
  codec,
  tags = {},
  picture,
  seconds = 2,
  sampleRate = 44_100,
  bitsPerSample = 16,
}: {
  codec: 'alac' | 'mp4a'
  tags?: TestTags
  picture?: TestPicture
  seconds?: number
  sampleRate?: number
  bitsPerSample?: number
}): Uint8Array<ArrayBuffer> {
  const samples = Math.round(seconds * sampleRate)
  const matrix = concat(
    u32be(0x00010000),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0x00010000),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0x40000000),
  )
  const mvhd = fullBox(
    'mvhd',
    0,
    u32be(0),
    u32be(0),
    u32be(1000),
    u32be(Math.round(seconds * 1000)),
    u32be(0x00010000),
    u16be(0x0100),
    new Uint8Array(10),
    matrix,
    new Uint8Array(24),
    u32be(2),
  )
  const tkhd = fullBox(
    'tkhd',
    1,
    u32be(0),
    u32be(0),
    u32be(1),
    u32be(0),
    u32be(Math.round(seconds * 1000)),
    new Uint8Array(8),
    u16be(0),
    u16be(0),
    u16be(0x0100),
    u16be(0),
    matrix,
    u32be(0),
    u32be(0),
  )
  const mdhd = fullBox(
    'mdhd',
    0,
    u32be(0),
    u32be(0),
    u32be(sampleRate),
    u32be(samples),
    u16be(0x55c4),
    u16be(0),
  )
  const hdlr = fullBox(
    'hdlr',
    0,
    u32be(0),
    latin1('soun'),
    new Uint8Array(12),
    latin1('SoundHandler\u0000'),
  )
  const config =
    codec === 'alac'
      ? fullBox(
          'alac',
          0,
          u32be(4096),
          Uint8Array.of(0, bitsPerSample, 40, 10, 14, 1),
          u16be(255),
          u32be(0),
          u32be(0),
          u32be(sampleRate),
        )
      : new Uint8Array(0)
  // AudioSampleEntry: reserved, data reference 1, version and vendor, channels, sample size,
  // compression ID and packet size, sample rate as 16.16.
  const entry = box(
    codec,
    new Uint8Array(6),
    u16be(1),
    new Uint8Array(8),
    u16be(1),
    u16be(bitsPerSample),
    u16be(0),
    u16be(0),
    u32be(sampleRate * 65536),
    config,
  )
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, u32be(1), entry),
    fullBox('stts', 0, u32be(0)),
    fullBox('stsc', 0, u32be(0)),
    fullBox('stsz', 0, u32be(0), u32be(0)),
    fullBox('stco', 0, u32be(0)),
  )
  const minf = box(
    'minf',
    fullBox('smhd', 0, u16be(0), u16be(0)),
    box('dinf', fullBox('dref', 0, u32be(1), fullBox('url ', 1))),
    stbl,
  )
  const items: Uint8Array[] = []
  if (tags.title !== undefined) items.push(ilstItem('©nam', 1, utf8(tags.title)))
  if (tags.artists !== undefined) items.push(ilstItem('©ART', 1, utf8(tags.artists.join(', '))))
  if (tags.albumArtist !== undefined) items.push(ilstItem('aART', 1, utf8(tags.albumArtist)))
  if (tags.album !== undefined) items.push(ilstItem('©alb', 1, utf8(tags.album)))
  if (tags.track !== undefined) {
    items.push(
      ilstItem(
        'trkn',
        0,
        concat(u16be(0), u16be(tags.track), u16be(tags.trackTotal ?? 0), u16be(0)),
      ),
    )
  }
  if (tags.date !== undefined) items.push(ilstItem('©day', 1, utf8(tags.date)))
  if (picture !== undefined) {
    items.push(ilstItem('covr', picture.mime === 'image/png' ? 14 : 13, picture.data))
  }
  const meta = fullBox(
    'meta',
    0,
    fullBox(
      'hdlr',
      0,
      u32be(0),
      latin1('mdir'),
      latin1('appl'),
      new Uint8Array(8),
      latin1('MetaHandler\u0000'),
    ),
    box('ilst', ...items),
  )
  const moov = box(
    'moov',
    mvhd,
    box('trak', tkhd, box('mdia', mdhd, hdlr, minf)),
    box('udta', meta),
  )
  const ftyp = box('ftyp', latin1('M4A '), u32be(0), latin1('M4A '), latin1('mp42'), latin1('isom'))
  return concat(ftyp, moov, box('mdat'))
}

// --- Ogg Opus ------------------------------------------------------------------------------

function oggPage(
  packet: Uint8Array,
  {
    serial,
    sequence,
    granule,
    type,
  }: { serial: number; sequence: number; granule: number; type: number },
): Uint8Array {
  const lacing: number[] = []
  let left = packet.length
  while (left >= 255) {
    lacing.push(255)
    left -= 255
  }
  lacing.push(left)
  const page = concat(
    latin1('OggS'),
    Uint8Array.of(0, type),
    u64le(granule),
    u32le(serial),
    u32le(sequence),
    u32le(0),
    Uint8Array.of(lacing.length),
    Uint8Array.from(lacing),
    packet,
  )
  page.set(u32le(oggCrc(page)), 22)
  return page
}

/** An Ogg Opus stream: OpusHead, OpusTags and silent 20 ms packets, 48 kHz, mono. */
export function opusFile({ tags = {}, packets = 50 }: { tags?: TestTags; packets?: number } = {}) {
  const preSkip = 312
  const head = concat(
    latin1('OpusHead'),
    Uint8Array.of(1, 1),
    u16le(preSkip),
    u32le(48_000),
    u16le(0),
    Uint8Array.of(0),
  )
  const comments = concat(latin1('OpusTags'), vorbisCommentBody(tags))
  const serial = 0x46584d21
  // A CELT 20 ms packet that decodes to silence.
  const silence = Uint8Array.of(0xf8, 0xff, 0xfe)
  const audio = Array.from({ length: packets }, (_, index) =>
    oggPage(silence, {
      serial,
      sequence: index + 2,
      granule: preSkip + (index + 1) * 960,
      type: index === packets - 1 ? 0x04 : 0,
    }),
  )
  return concat(
    oggPage(head, { serial, sequence: 0, granule: 0, type: 0x02 }),
    oggPage(comments, { serial, sequence: 1, granule: 0, type: 0 }),
    ...audio,
  )
}

/** `bytes` as a `File`, as a file input or a folder handle hands it out. */
export function audioFile(
  bytes: Uint8Array,
  name: string,
  { type = '', lastModified = Date.UTC(2026, 9, 1) }: { type?: string; lastModified?: number } = {},
): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type, lastModified })
}
