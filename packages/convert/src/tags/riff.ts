/**
 * WAV tags: a LIST/INFO chunk (title, artists, album, track, date, and FXM's note on a file
 * converted from lossy audio as its comment), which Windows and most players read, and an `id3 `
 * chunk with the full ID3v2.3 tag (cover, lyrics and the converted file's source too), which
 * foobar2000, MusicBee, iTunes and FFmpeg read. Earlier LIST/INFO and ID3 chunks are replaced;
 * the format and data chunks stay as they are.
 *
 * @module
 */

import { ByteWriter, concat, hasAscii, readU32LE, utf8 } from '../bytes'
import type { ExportTags } from '../types'
import { conversionNote, joinedArtists, positive } from './fields'
import { buildId3v2 } from './id3v2'

interface Chunk {
  readonly id: string
  /** The whole chunk: header, data and the pad byte of an odd length. */
  readonly bytes: Uint8Array
  /** The LIST type (`INFO`, `adtl`…), for LIST chunks. */
  readonly listType?: string
}

function chunk(id: string, data: Uint8Array): Uint8Array {
  const writer = new ByteWriter().ascii(id).u32le(data.length).bytes(data)
  if (data.length % 2 === 1) writer.u8(0)
  return writer.finish()
}

function infoChunk(tags: ExportTags): Uint8Array | undefined {
  const entries: Uint8Array[] = []
  const add = (id: string, value: string | number | undefined) => {
    if (value === undefined || String(value).trim() === '') return
    // INFO strings end with a NUL; UTF-8, as FFmpeg and current tools write them.
    entries.push(chunk(id, concat([utf8(String(value)), new Uint8Array([0])])))
  }
  add('INAM', tags.title)
  add('IART', joinedArtists(tags))
  add('IPRD', tags.album)
  add('ITRK', positive(tags.trackNumber))
  add('ICRD', tags.releaseDate)
  add('ICMT', conversionNote(tags))
  if (entries.length === 0) return undefined
  return chunk('LIST', concat([utf8('INFO'), ...entries]))
}

function readChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = []
  let at = 12
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4))
    const size = readU32LE(bytes, at + 4)
    const end = at + 8 + size + (size % 2)
    if (at + 8 + size > bytes.length) throw new RangeError(`The ${id} chunk runs past the file`)
    const listType =
      id === 'LIST' && size >= 4
        ? String.fromCharCode(...bytes.subarray(at + 8, at + 12))
        : undefined
    chunks.push({
      id,
      bytes: bytes.subarray(at, Math.min(end, bytes.length)),
      ...(listType === undefined ? {} : { listType }),
    })
    at = end
  }
  return chunks
}

/**
 * A WAV file with `tags` as its only metadata, in a LIST/INFO chunk and an `id3 ` chunk after
 * the audio.
 *
 * @throws RangeError when `bytes` is not a RIFF WAVE file or its chunks run past its end (a WAV
 * written while streaming, with sizes it never fixed).
 */
export function writeWavTags(bytes: Uint8Array, tags: ExportTags): Uint8Array {
  if (!hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WAVE')) {
    throw new RangeError('Not a WAV file')
  }
  const kept = readChunks(bytes).filter(
    (item) =>
      !(item.id === 'LIST' && item.listType === 'INFO') && item.id !== 'id3 ' && item.id !== 'ID3 ',
  )
  if (!kept.some((item) => item.id === 'data')) throw new RangeError('The WAV file has no audio')
  const added = [infoChunk(tags), chunk('id3 ', buildId3v2(tags))].filter(
    (item): item is Uint8Array => item !== undefined,
  )
  const body = concat([utf8('WAVE'), ...kept.map((item) => item.bytes), ...added])
  if (body.length > 0xffffffff) throw new RangeError('The WAV file is too large for RIFF')
  return concat([new ByteWriter().ascii('RIFF').u32le(body.length).finish(), body])
}
