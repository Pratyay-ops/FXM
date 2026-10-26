/**
 * SHA-256 checksums of plugin code, and the one way FXM turns code bytes into text. Pure
 * JavaScript (`@noble/hashes`, as `@fxm/platform`'s signed updates use it), so it works the same
 * in every browser, webview and Node, also where WebCrypto is missing (a page served over plain
 * HTTP).
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { PluginError } from './errors'

/** The SHA-256 of `bytes`, in lower-case hexadecimal. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/** The UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Plugin code as text: its bytes decoded as UTF-8, keeping a byte order mark, so that encoding
 * the text again gives the same bytes and the same checksum.
 *
 * @throws PluginError `invalid-file` when the bytes are not UTF-8.
 */
export function codeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new PluginError('invalid-file', 'The plugin code is not UTF-8 text', { cause: error })
  }
}

/**
 * Checks code against the SHA-256 its manifest declares.
 *
 * @throws PluginError `checksum-mismatch` when they differ.
 */
export function verifyChecksum(code: string | Uint8Array, expected: string): void {
  const actual = sha256Hex(typeof code === 'string' ? utf8(code) : code)
  if (actual !== expected.toLowerCase()) {
    throw new PluginError(
      'checksum-mismatch',
      `The plugin code's SHA-256 is ${actual}, but its manifest declares ${expected.toLowerCase()}`,
    )
  }
}
