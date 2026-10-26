/**
 * SHA-256, as signed updates use it: the hash of an artifact in its statement, and the ID of a
 * public key. Pure JavaScript (`@noble/hashes`), so it works the same everywhere.
 *
 * Node runs this file directly in the signing scripts (type stripping), so its imports spell
 * out `.ts`.
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { toHex } from './encoding.ts'

/** The SHA-256 of `bytes`, in lower-case hexadecimal, as statements carry it. */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes))
}

/**
 * The ID of a public key: `ed25519-` and the first 16 hexadecimal digits of its SHA-256.
 * Signature files name the key that signed them by this ID, and apps look it up among the keys
 * they trust.
 */
export function keyIdOf(publicKey: Uint8Array): string {
  return `ed25519-${sha256Hex(publicKey).slice(0, 16)}`
}
