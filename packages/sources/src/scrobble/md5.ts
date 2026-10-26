/**
 * MD5 (RFC 1321), which Last.fm's API signatures use. WebCrypto has no MD5, and the signature is
 * only a request checksum keyed with the user's shared secret, so a small implementation of the
 * RFC is enough: no dependency for one hash.
 *
 * Never use it for anything that needs a secure hash.
 *
 * @module
 */

/** Per-step left rotations: four per round, each used for every fourth step of its round. */
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21] as const

/** The 64 step constants of RFC 1321, section 3.4: the integer part of 2^32 · |sin(i + 1)|. */
const STEP_CONSTANTS = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
])

/** `value` rotated left by `bits`, as an unsigned 32-bit integer. */
function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

/** The message with RFC 1321's padding: a 1 bit, zeros, then its length in bits (64-bit LE). */
function pad(message: Uint8Array): Uint8Array {
  const blocks = ((message.length + 8) >>> 6) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  // The length in bits, low word first. `>>> 29` carries the bits that `<< 3` would lose.
  view.setUint32(padded.length - 8, (message.length << 3) >>> 0, true)
  view.setUint32(padded.length - 4, message.length >>> 29, true)
  return padded
}

/** The MD5 digest of `message`, as 16 bytes. */
export function md5(message: Uint8Array): Uint8Array {
  const padded = pad(message)
  const view = new DataView(padded.buffer)
  const words = new Uint32Array(16)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let step = 0; step < 64; step++) {
      let mixed: number
      let word: number
      if (step < 16) {
        mixed = (b & c) | (~b & d)
        word = step
      } else if (step < 32) {
        mixed = (d & b) | (~d & c)
        word = (5 * step + 1) % 16
      } else if (step < 48) {
        mixed = b ^ c ^ d
        word = (3 * step + 5) % 16
      } else {
        mixed = c ^ (b | ~d)
        word = (7 * step) % 16
      }
      const shift = SHIFTS[(step >>> 4) * 4 + (step & 3)] as number
      const sum = (a + mixed + (STEP_CONSTANTS[step] as number) + (words[word] as number)) >>> 0
      a = d
      d = c
      c = b
      b = (b + rotateLeft(sum, shift)) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const digest = new Uint8Array(16)
  const out = new DataView(digest.buffer)
  out.setUint32(0, a0, true)
  out.setUint32(4, b0, true)
  out.setUint32(8, c0, true)
  out.setUint32(12, d0, true)
  return digest
}

/** The MD5 digest of a string's UTF-8 bytes, as 32 lower-case hexadecimal digits. */
export function md5Hex(text: string): string {
  return Array.from(md5(new TextEncoder().encode(text)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
