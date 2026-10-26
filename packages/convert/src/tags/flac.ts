/**
 * FLAC tags: the metadata blocks before the audio frames. FXM keeps the blocks that describe the
 * audio (STREAMINFO, SEEKTABLE, CUESHEET, APPLICATION), replaces the comments and pictures with
 * its own, and leaves the frames untouched.
 *
 * @module
 */

import { ByteWriter, concat, hasAscii, readU24BE } from '../bytes'
import type { ExportTags } from '../types'
import { stripId3v2 } from './id3v2'
import { encodeComments, flacPicture, readVendor } from './vorbis'

const STREAMINFO = 0
const PADDING = 1
const VORBIS_COMMENT = 4
const PICTURE = 6
/** A block's length is 24 bits. */
const MAX_BLOCK_BYTES = 2 ** 24 - 1

interface Block {
  readonly type: number
  readonly body: Uint8Array
}

function block(type: number, body: Uint8Array, last: boolean): Uint8Array {
  return new ByteWriter()
    .u8((last ? 0x80 : 0) | type)
    .u24be(body.length)
    .bytes(body)
    .finish()
}

/** The metadata blocks of a FLAC stream and where its frames start. */
function readBlocks(bytes: Uint8Array): { blocks: Block[]; framesAt: number } {
  if (!hasAscii(bytes, 0, 'fLaC')) throw new RangeError('Not a FLAC file')
  const blocks: Block[] = []
  let at = 4
  for (;;) {
    if (at + 4 > bytes.length) throw new RangeError('The FLAC file ends inside its metadata')
    const header = bytes[at] ?? 0
    const length = readU24BE(bytes, at + 1)
    const end = at + 4 + length
    if (end > bytes.length) throw new RangeError('A FLAC metadata block runs past the file')
    blocks.push({ type: header & 0x7f, body: bytes.subarray(at + 4, end) })
    at = end
    if (header & 0x80) return { blocks, framesAt: at }
  }
}

/**
 * A FLAC file with `tags` as its comments and picture. An ID3v2 tag before the stream, which
 * some tools add, is dropped. The vendor string of the original comments is kept (it names the
 * encoder); a stream without one gets "FXM".
 *
 * @throws RangeError when `bytes` is not a FLAC stream.
 */
export function writeFlacTags(bytes: Uint8Array, tags: ExportTags): Uint8Array {
  const stream = stripId3v2(bytes)
  const { blocks, framesAt } = readBlocks(stream)
  if (blocks[0]?.type !== STREAMINFO) throw new RangeError('A FLAC stream starts with STREAMINFO')
  const oldComments = blocks.find((item) => item.type === VORBIS_COMMENT)
  const vendor = (oldComments && readVendor(oldComments.body)) || 'FXM'
  const kept = blocks.filter(
    (item) => item.type !== VORBIS_COMMENT && item.type !== PICTURE && item.type !== PADDING,
  )
  const added: Block[] = [{ type: VORBIS_COMMENT, body: encodeComments(vendor, tags) }]
  if (tags.cover !== undefined) {
    const picture = flacPicture(tags.cover)
    if (picture.length <= MAX_BLOCK_BYTES) added.push({ type: PICTURE, body: picture })
  }
  const all = [...kept, ...added]
  const encoded = all.map((item, index) => block(item.type, item.body, index === all.length - 1))
  return concat([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...encoded, stream.subarray(framesAt)])
}
