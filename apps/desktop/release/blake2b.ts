/**
 * BLAKE2b (RFC 7693) with any output length from 1 to 64 bytes, unkeyed.
 *
 * Node's crypto has BLAKE2b only with a 64-byte output (`blake2b512`), and the output length is
 * part of BLAKE2b's parameter block, so a shorter hash is not a cut-off longer one. minisign
 * checks a secret key with BLAKE2b-256 (`minisign.ts`), which is the only use here: a few dozen
 * bytes, so plain BigInt arithmetic is fast enough. Files are hashed with Node's own BLAKE2b-512.
 *
 * @module
 */

const MASK = (1n << 64n) - 1n

/** The initialization vector: SHA-512's (RFC 7693, section 2.6). */
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
] as const

/** The message word schedule of each round (RFC 7693, section 2.7); rounds 10 and 11 reuse 0 and 1. */
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const

const BLOCK_BYTES = 128

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK

/** The 64-bit word at `index` of a block, little-endian. */
function word(block: Uint8Array, index: number): bigint {
  let value = 0n
  for (let byte = 7; byte >= 0; byte--) {
    value = (value << 8n) | BigInt(block[index * 8 + byte] ?? 0)
  }
  return value
}

/** The compression function F (RFC 7693, section 3.2). */
function compress(h: bigint[], block: Uint8Array, counter: bigint, last: boolean) {
  const m = Array.from({ length: 16 }, (_, index) => word(block, index))
  const v = [...h, ...IV]
  const at = (index: number) => v[index] ?? 0n
  const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (at(a) + at(b) + x) & MASK
    v[d] = rotr(at(d) ^ at(a), 32n)
    v[c] = (at(c) + at(d)) & MASK
    v[b] = rotr(at(b) ^ at(c), 24n)
    v[a] = (at(a) + at(b) + y) & MASK
    v[d] = rotr(at(d) ^ at(a), 16n)
    v[c] = (at(c) + at(d)) & MASK
    v[b] = rotr(at(b) ^ at(c), 63n)
  }
  v[12] = at(12) ^ (counter & MASK)
  v[13] = at(13) ^ (counter >> 64n)
  if (last) v[14] = at(14) ^ MASK
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10] ?? SIGMA[0]
    const msg = (index: number) => m[s[index] ?? 0] ?? 0n
    mix(0, 4, 8, 12, msg(0), msg(1))
    mix(1, 5, 9, 13, msg(2), msg(3))
    mix(2, 6, 10, 14, msg(4), msg(5))
    mix(3, 7, 11, 15, msg(6), msg(7))
    mix(0, 5, 10, 15, msg(8), msg(9))
    mix(1, 6, 11, 12, msg(10), msg(11))
    mix(2, 7, 8, 13, msg(12), msg(13))
    mix(3, 4, 9, 14, msg(14), msg(15))
  }
  for (let index = 0; index < 8; index++) {
    h[index] = (h[index] ?? 0n) ^ at(index) ^ at(index + 8)
  }
}

/** The BLAKE2b hash of `data`, `outputBytes` long (1 to 64). */
export function blake2b(data: Uint8Array, outputBytes: number): Uint8Array {
  if (!Number.isInteger(outputBytes) || outputBytes < 1 || outputBytes > 64) {
    throw new RangeError(`BLAKE2b's output is 1 to 64 bytes, not ${outputBytes}`)
  }
  const h: bigint[] = [...IV]
  // The parameter block's first word: no key, fan-out and depth 1, the output length.
  h[0] = (h[0] ?? 0n) ^ 0x01010000n ^ BigInt(outputBytes)
  let offset = 0
  // Every block but the last; an empty message is one empty last block.
  while (data.length - offset > BLOCK_BYTES) {
    compress(h, data.subarray(offset, offset + BLOCK_BYTES), BigInt(offset + BLOCK_BYTES), false)
    offset += BLOCK_BYTES
  }
  const last = new Uint8Array(BLOCK_BYTES)
  last.set(data.subarray(offset))
  compress(h, last, BigInt(data.length), true)
  const out = new Uint8Array(64)
  h.forEach((value, index) => {
    for (let byte = 0; byte < 8; byte++)
      out[index * 8 + byte] = Number((value >> BigInt(8 * byte)) & 0xffn)
  })
  return out.slice(0, outputBytes)
}
