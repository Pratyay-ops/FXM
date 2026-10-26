/**
 * ISO base media file format boxes (MP4): building them, and finding them in a file.
 *
 * @module
 */

import { ascii, ByteWriter, concat, latin1, readU32BE, readU64BE } from '../bytes'

/** A box of `type` holding `children` (already encoded boxes or raw fields). */
export function box(type: string, ...children: readonly Uint8Array[]): Uint8Array {
  const body = concat(children)
  return concat([
    new ByteWriter()
      .u32be(8 + body.length)
      .bytes(latin1(type))
      .finish(),
    body,
  ])
}

/** A full box: a box whose body starts with a version byte and 24 bits of flags. */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...children: readonly Uint8Array[]
): Uint8Array {
  return box(type, new ByteWriter().u8(version).u24be(flags).finish(), ...children)
}

/** A box found in a file: its type, where it starts, its header and total length. */
export interface FoundBox {
  readonly type: string
  readonly offset: number
  readonly headerLength: number
  readonly length: number
}

/** The boxes in `bytes` between `start` and `end`, in order. */
export function childBoxes(bytes: Uint8Array, start = 0, end = bytes.length): FoundBox[] {
  const found: FoundBox[] = []
  let at = start
  while (at + 8 <= end) {
    let length = readU32BE(bytes, at)
    let headerLength = 8
    if (length === 1) {
      length = readU64BE(bytes, at + 8)
      headerLength = 16
    } else if (length === 0) {
      length = end - at
    }
    if (length < headerLength || at + length > end) break
    found.push({ type: ascii(bytes, at + 4, 4), offset: at, headerLength, length })
    at += length
  }
  return found
}

/**
 * The box at a path of types, e.g. `['moov', 'udta', 'meta', 'ilst']`, or `undefined`. Full
 * boxes on the way (`meta`) are stepped into past their version and flags.
 */
export function findBox(bytes: Uint8Array, path: readonly string[]): FoundBox | undefined {
  let start = 0
  let end = bytes.length
  let found: FoundBox | undefined
  for (const type of path) {
    found = childBoxes(bytes, start, end).find((item) => item.type === type)
    if (found === undefined) return undefined
    start = found.offset + found.headerLength + (type === 'meta' ? 4 : 0)
    end = found.offset + found.length
  }
  return found
}
