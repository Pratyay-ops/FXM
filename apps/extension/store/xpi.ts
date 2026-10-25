/**
 * Checks a signed XPI from AMO before a release attaches it: it must carry Mozilla's signature,
 * the expected add-on ID and version, and exactly the files of the build that was submitted.
 * AMO adds only META-INF/ (the signature) to an extension, so every other file must match the
 * build byte for byte.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string
  data: Uint8Array
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * Reads the files of a zip through its central directory: stored or deflated entries, no
 * encryption, no ZIP64 (extensions are far below 4 GiB). Folders are left out. Throws on
 * anything malformed, including a CRC or size that doesn't match.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (why: string): never => {
    throw new Error(`not a readable zip: ${why}`)
  }
  // The end-of-central-directory record is 22 bytes plus a comment of up to 65535 bytes.
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) fail('no end of central directory')
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff) fail('ZIP64 is not supported')
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL) {
      fail(`bad central directory entry ${i}`)
    }
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (flags & 1) fail(`${name} is encrypted`)
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL) {
      fail(`bad local header for ${name}`)
    }
    const start =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    if (start + compressedSize > zip.length) fail(`${name} runs past the end of the file`)
    if (name.endsWith('/')) continue
    const body = zip.subarray(start, start + compressedSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(body)
    else if (method === 8) data = inflateRawSync(body)
    else data = fail(`${name} uses compression method ${method}`)
    if (data.length !== size || crc32(data) !== crc) fail(`${name} is damaged`)
    entries.push({ name, data })
  }
  return entries
}

/**
 * The files of a build folder by their path inside it, the way `web-ext build` packs them: dot
 * files and dot folders (such as the `.amo-upload-uuid` that `web-ext sign` leaves) are skipped.
 */
export async function readBuild(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
    if (path.split('/').some((part) => part.startsWith('.'))) continue
    files.set(path, await readFile(join(dir, path)))
  }
  return files
}

/** Files that hold Mozilla's signature of an add-on: the PKCS#7 one, the COSE one or both. */
export const SIGNATURE_FILES = ['META-INF/mozilla.rsa', 'META-INF/cose.sig'] as const

export interface XpiExpectation {
  id: string
  version: string
  /** The build that was submitted, from readBuild. */
  files: ReadonlyMap<string, Uint8Array>
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

/** Throws, saying what is wrong, unless the XPI is the signed copy of the expected build. */
export function checkSignedXpi(xpi: Uint8Array, expected: XpiExpectation): void {
  const entries = readZip(xpi)
  const names = new Set(entries.map((entry) => entry.name))
  if (!SIGNATURE_FILES.some((name) => names.has(name))) {
    throw new Error(`the XPI carries no Mozilla signature (${SIGNATURE_FILES.join(' or ')})`)
  }
  const content = new Map(
    entries
      .filter((entry) => !entry.name.startsWith('META-INF/'))
      .map((entry) => [entry.name, entry.data]),
  )
  const manifestBytes = content.get('manifest.json')
  if (!manifestBytes) throw new Error('the XPI has no manifest.json')
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
    version?: unknown
    browser_specific_settings?: { gecko?: { id?: unknown } }
  }
  if (manifest.version !== expected.version) {
    throw new Error(
      `the XPI is version ${String(manifest.version)}, not ${expected.version}: AMO sent the wrong file`,
    )
  }
  const id = manifest.browser_specific_settings?.gecko?.id
  if (id !== expected.id) {
    throw new Error(`the XPI's add-on ID is ${String(id)}, not ${expected.id}`)
  }
  const problems: string[] = []
  for (const [name, data] of expected.files) {
    const signed = content.get(name)
    if (!signed) problems.push(`${name} is missing`)
    else if (!sameBytes(signed, data)) problems.push(`${name} differs from the build`)
  }
  for (const name of content.keys()) {
    if (!expected.files.has(name)) problems.push(`${name} is not in the build`)
  }
  if (problems.length > 0) {
    throw new Error(`the XPI doesn't match the build: ${problems.join('; ')}`)
  }
}
