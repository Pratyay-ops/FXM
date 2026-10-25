/**
 * Minimal, deterministic ZIP writer (deflate or store, no ZIP64) for packaging the extension.
 * Entries keep the given order and a fixed timestamp, so the same input always gives the same
 * bytes, which keeps release builds reproducible for store review.
 */
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string
  data: Uint8Array
}

/** 1980-01-01 00:00, the earliest DOS timestamp (year offset 0, month 1, day 1). */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1
const VERSION = 20 // 2.0: deflate
const MADE_BY_UNIX = (3 << 8) | VERSION
const UTF8_FLAG = 0x0800
const FILE_MODE = 0o100644

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const names = new Set<string>()
  let offset = 0
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\')) {
      throw new Error(`invalid zip entry name: ${entry.name}`)
    }
    if (names.has(entry.name)) throw new Error(`duplicate zip entry: ${entry.name}`)
    names.add(entry.name)
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const stored = deflated.length >= entry.data.length
    const body = stored ? Buffer.from(entry.data) : deflated
    const method = stored ? 0 : 8
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(MADE_BY_UNIX, 4)
    central.writeUInt16LE(VERSION, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    // extra length, comment length, disk number and internal attributes stay 0
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
