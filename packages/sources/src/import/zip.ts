/**
 * Just enough of the ZIP format to read Spotify's data export as it is downloaded: the central
 * directory, and entries that are stored or deflated, inflated with the platform's
 * `DecompressionStream('deflate-raw')`. Only the entries a caller asks for are inflated, each
 * within a size limit that holds even when an entry lies about its size, so a hostile archive
 * cannot exhaust memory. ZIP64, encryption and multi-disk archives are refused.
 *
 * @module
 */

import { ImportInputError } from './errors'

/** A file unpacked from an archive. */
export interface ZipFile {
  /** The path inside the archive. */
  name: string
  /** Its bytes. */
  bytes: Uint8Array
}

/** Options for {@link readZip}. */
export interface ReadZipOptions {
  /** Which entries to unpack, by path. Directories are never passed. */
  want: (name: string) => boolean
  /** The largest entry to unpack, in bytes. Default 64 MiB. */
  maxEntryBytes?: number
  /** The most bytes to unpack in all. Default 512 MiB. */
  maxTotalBytes?: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Whether `bytes` start like a ZIP archive (a local file header, or an empty archive). */
export function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const signature = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  return signature === LOCAL || signature === EOCD
}

function badZip(message: string): ImportInputError {
  return new ImportInputError('bad-zip', message)
}

/**
 * The entries a caller wants from a ZIP archive, unpacked, in the archive's order.
 *
 * @throws ImportInputError `bad-zip` for an archive that cannot be read (damaged, ZIP64,
 * encrypted, split) or an entry over the limits; `zip-unsupported` where the platform cannot
 * inflate (`DecompressionStream` without `deflate-raw`).
 */
export async function readZip(bytes: Uint8Array, options: ReadZipOptions): Promise<ZipFile[]> {
  const maxEntry = options.maxEntryBytes ?? 64 * 1024 * 1024
  const maxTotal = options.maxTotalBytes ?? 512 * 1024 * 1024
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  const disk = view.getUint16(eocd + 4, true)
  const entries = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (disk !== 0) throw badZip('Split ZIP archives cannot be read')
  if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw badZip('ZIP64 archives cannot be read')
  }
  if (directoryOffset + directorySize > eocd) throw badZip('The ZIP archive is damaged')
  const files: ZipFile[] = []
  let total = 0
  let offset = directoryOffset
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL) {
      throw badZip('The ZIP archive is damaged')
    }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/') || !options.want(name)) continue
    if ((flags & 1) !== 0) throw badZip(`${name} is encrypted`)
    if (size === 0xffffffff || compressedSize === 0xffffffff) {
      throw badZip('ZIP64 archives cannot be read')
    }
    if (size > maxEntry || total + size > maxTotal) {
      throw new ImportInputError('too-large', `${name} is too large to import`)
    }
    const data = entryData(view, bytes, localOffset, compressedSize)
    let unpacked: Uint8Array
    if (method === 0) unpacked = data
    else if (method === 8) unpacked = await inflateRaw(data, size)
    else throw badZip(`${name} uses a compression method FXM cannot read`)
    if (unpacked.length !== size) throw badZip(`${name} is damaged`)
    total += size
    files.push({ name, bytes: unpacked })
  }
  return files
}

/** The offset of the end-of-central-directory record, searched for from the end. */
function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - 22
  const first = Math.max(0, last - 0xffff)
  for (let offset = last; offset >= first; offset--) {
    if (view.getUint32(offset, true) === EOCD) return offset
  }
  throw badZip('Not a ZIP archive, or a damaged one')
}

/** An entry's compressed bytes, found through its local file header. */
function entryData(
  view: DataView,
  bytes: Uint8Array,
  localOffset: number,
  compressedSize: number,
): Uint8Array {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL) {
    throw badZip('The ZIP archive is damaged')
  }
  const start =
    localOffset +
    30 +
    view.getUint16(localOffset + 26, true) +
    view.getUint16(localOffset + 28, true)
  if (start + compressedSize > bytes.length) throw badZip('The ZIP archive is cut short')
  return bytes.subarray(start, start + compressedSize)
}

/**
 * Inflates raw deflate data, stopping as soon as the output passes `size`, the size the
 * archive claims: an entry may not unpack to more than it says.
 */
async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  let stream: DecompressionStream
  try {
    stream = new DecompressionStream('deflate-raw')
  } catch {
    throw new ImportInputError(
      'zip-unsupported',
      'This browser cannot unpack ZIP files: unpack the archive and choose its files',
    )
  }
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  // Errors surface on the reader; these promises only need handling.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {})
  writer.close().catch(() => {})
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > size) {
        await reader.cancel().catch(() => {})
        throw badZip('A file in the ZIP archive unpacks to more than it claims')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ImportInputError) throw error
    throw badZip('A file in the ZIP archive is damaged')
  }
  const result = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    result.set(chunk, at)
    at += chunk.byteLength
  }
  return result
}
