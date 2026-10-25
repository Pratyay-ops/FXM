/**
 * Small pure helpers the sync builds on: a canonical JSON form, a fast content hash and the
 * UTF-8 size of a string.
 *
 * - **Canonical JSON** sorts object keys, so the same data always gives the same text, whatever
 *   order its fields were written in (a record from IndexedDB, one cleaned by `validate.ts`, one
 *   parsed from GitHub). Equality checks, fingerprints and part names all use it.
 * - **The hash** is cyrb53, a 53-bit non-cryptographic hash. It names gist files after their
 *   content and checks them when they come back; nobody gains anything by forging a collision,
 *   because whoever holds the token can write the gist anyway.
 *
 * @module
 */

/**
 * `value` as JSON with every object's keys sorted. Like `JSON.stringify`, it leaves out object
 * fields whose value is `undefined` and writes `null` for `undefined` array items.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = []
  write(value, out)
  return out.join('')
}

function write(value: unknown, out: string[]): void {
  if (value === null || typeof value !== 'object') {
    // Strings, numbers and booleans as JSON does; undefined, functions and symbols as null.
    out.push(JSON.stringify(value) ?? 'null')
    return
  }
  if (Array.isArray(value)) {
    out.push('[')
    value.forEach((item, index) => {
      if (index > 0) out.push(',')
      write(item, out)
    })
    out.push(']')
    return
  }
  const record = value as Record<string, unknown>
  out.push('{')
  let first = true
  for (const key of Object.keys(record).sort()) {
    const field = record[key]
    if (field === undefined || typeof field === 'function' || typeof field === 'symbol') continue
    if (!first) out.push(',')
    first = false
    out.push(JSON.stringify(key), ':')
    write(field, out)
  }
  out.push('}')
}

/** Whether two values have the same canonical JSON (`undefined` counts as `null`). */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null)
}

/** cyrb53: a 53-bit hash of `text`, as a safe integer. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** {@link hash53} as 14 lower-case hex digits. */
export function hashHex(text: string): string {
  return hash53(text).toString(16).padStart(14, '0')
}

/** How many bytes `text` takes in UTF-8, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair: one code point, four bytes.
        bytes += 4
        index++
      } else {
        bytes += 3
      }
    } else bytes += 3
  }
  return bytes
}
