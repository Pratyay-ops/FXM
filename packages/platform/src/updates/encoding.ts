/**
 * Byte helpers for signed updates: UTF-8, Base64 and hexadecimal, with only the APIs every
 * platform has (`TextEncoder`, `TextDecoder`, `atob`, `btoa`).
 *
 * Node runs this file directly in the signing scripts (type stripping), so it imports nothing.
 *
 * @module
 */

const encoder = new TextEncoder()

/** The UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text)
}

/**
 * The text of UTF-8 `bytes`.
 *
 * @throws TypeError when the bytes are not valid UTF-8: signed text is never repaired.
 */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Standard Base64 with padding, nothing else: no white space, no URL alphabet. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** `bytes` in standard Base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

/** The bytes of standard, padded Base64 `text`, or `undefined` when it is anything else. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64.test(text)) return undefined
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** `bytes` as lower-case hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** The bytes of lower-case hexadecimal `text` (an even number of digits), or `undefined`. */
export function fromHex(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[0-9a-f]{2})*$/u.test(text)) return undefined
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** `parts` joined into one array. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

/** Whether two byte arrays hold the same bytes. Only for public data: it is not constant-time. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
