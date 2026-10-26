/**
 * Vorbis comments, the tags of FLAC, Ogg Opus and Ogg Vorbis files, and the FLAC picture block
 * that holds their cover (in Ogg as a METADATA_BLOCK_PICTURE comment).
 *
 * Fields: TITLE, ARTIST (one per artist), ALBUM, TRACKNUMBER, DISCNUMBER, DATE, ISRC, LYRICS.
 *
 * @module
 */

import { ByteWriter, base64, readU32LE, utf8 } from '../bytes'
import type { CoverArt, ExportTags } from '../types'
import { plainLyrics, positive } from './fields'

/** The comment fields of `tags`, as name and value. */
export function commentFields(tags: ExportTags): [string, string][] {
  const fields: [string, string][] = []
  const add = (name: string, value: string | number | undefined) => {
    if (value === undefined) return
    const text = String(value)
    if (text.trim() !== '') fields.push([name, text])
  }
  add('TITLE', tags.title)
  for (const artist of tags.artists) add('ARTIST', artist)
  add('ALBUM', tags.album)
  add('TRACKNUMBER', positive(tags.trackNumber))
  add('DISCNUMBER', positive(tags.discNumber))
  add('DATE', tags.releaseDate)
  add('ISRC', tags.isrc)
  add('LYRICS', plainLyrics(tags))
  return fields
}

/** A FLAC PICTURE block's body (big-endian): a front cover. */
export function flacPicture(cover: CoverArt): Uint8Array {
  const mime = utf8(cover.mimeType)
  return new ByteWriter()
    .u32be(3) // front cover
    .u32be(mime.length)
    .bytes(mime)
    .u32be(0) // no description
    .u32be(cover.width ?? 0)
    .u32be(cover.height ?? 0)
    .u32be(cover.mimeType === 'image/png' ? 32 : 24) // colour depth
    .u32be(0) // not an indexed image
    .u32be(cover.data.length)
    .bytes(cover.data)
    .finish()
}

/**
 * A comment list (little-endian lengths): the vendor string, then each `NAME=value`. Ogg files
 * get their cover as a base64 METADATA_BLOCK_PICTURE comment (`pictureInComments`); FLAC files
 * keep it in a PICTURE block of their own.
 */
export function encodeComments(
  vendor: string,
  tags: ExportTags,
  { pictureInComments = false }: { pictureInComments?: boolean } = {},
): Uint8Array {
  const entries = commentFields(tags).map(([name, value]) => utf8(`${name}=${value}`))
  if (pictureInComments && tags.cover !== undefined) {
    entries.push(utf8(`METADATA_BLOCK_PICTURE=${base64(flacPicture(tags.cover))}`))
  }
  const vendorBytes = utf8(vendor)
  const writer = new ByteWriter().u32le(vendorBytes.length).bytes(vendorBytes).u32le(entries.length)
  for (const entry of entries) writer.u32le(entry.length).bytes(entry)
  return writer.finish()
}

/** The vendor string at the start of a comment list, or `undefined` when it can't be read. */
export function readVendor(comments: Uint8Array): string | undefined {
  if (comments.length < 4) return undefined
  const length = readU32LE(comments, 0)
  if (4 + length > comments.length) return undefined
  return new TextDecoder().decode(comments.subarray(4, 4 + length))
}
