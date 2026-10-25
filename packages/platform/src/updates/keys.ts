/**
 * The public keys an FXM build trusts for signed updates. They are compiled into each build
 * from `update-keys.json`, so a hijacked site or a leaked deploy token can't change them: only
 * an app update can.
 *
 * Until the owner creates the real key pair (`scripts/make-signing-key.sh`), the file holds a
 * placeholder that is not a key. A build with no valid key **fails closed**: it accepts no
 * signed update at all and uses the config and module it ships with.
 *
 * @module
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { keyIdOf } from './digest.ts'
import { fromBase64 } from './encoding.ts'
import keyFile from './update-keys.json'

/** A public key an FXM build trusts. */
export interface TrustedKey {
  /** Its ID, `ed25519-` and 16 hexadecimal digits, which signature files name. */
  readonly id: string
  /** The 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array<ArrayBuffer>
}

/** The keys a build trusts, and why any entry was left out. */
export interface TrustedKeys {
  /** The valid keys. Empty means every signed update is refused. */
  readonly keys: readonly TrustedKey[]
  /** One line per entry that is not a valid key, such as the placeholder. */
  readonly problems: readonly string[]
}

/**
 * Whether `publicKey` is a usable Ed25519 public key: 32 bytes that decode to a curve point in
 * the strict encoding of RFC 8032, outside the small subgroup and in the prime-order one.
 * Small-order keys would let anyone forge signatures, so they are refused before any check.
 */
export function isValidPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false
  try {
    const point = ed25519.Point.fromBytes(publicKey, false)
    return !point.isSmallOrder() && point.isTorsionFree()
  } catch {
    return false
  }
}

/**
 * Reads a list of trusted keys in the format of `update-keys.json`: `{ keys: [{ id, publicKey
 * }] }`, with each `publicKey` in Base64. An entry is kept only when its key is valid and its
 * `id` is the key's own ID ({@link keyIdOf}), so a typo can't slip through.
 */
export function parseTrustedKeys(input: unknown): TrustedKeys {
  const entries = (input as { keys?: unknown } | null)?.keys
  if (!Array.isArray(entries)) return { keys: [], problems: ['The key list has no "keys" array'] }
  const keys: TrustedKey[] = []
  const problems: string[] = []
  for (const [index, entry] of entries.entries()) {
    const { id, publicKey } = (entry ?? {}) as { id?: unknown; publicKey?: unknown }
    const name = typeof id === 'string' ? id : `entry ${index}`
    const bytes = typeof publicKey === 'string' ? fromBase64(publicKey) : undefined
    if (bytes === undefined || !isValidPublicKey(bytes)) {
      problems.push(`${name} is not an Ed25519 public key`)
    } else if (id !== keyIdOf(bytes)) {
      problems.push(`${name} should have the ID ${keyIdOf(bytes)}`)
    } else if (keys.some((key) => key.id === id)) {
      problems.push(`${name} is listed twice`)
    } else {
      keys.push({ id, publicKey: bytes })
    }
  }
  return { keys, problems }
}

/** The keys compiled into this build, from `update-keys.json`. */
export const UPDATE_SIGNING_KEYS: TrustedKeys = parseTrustedKeys(keyFile)

/**
 * Whether this build trusts at least one real key. `false` while `update-keys.json` holds only
 * the placeholder: such a build refuses every signed update, and a release job can check this
 * to refuse to ship it.
 */
export const UPDATE_SIGNING_READY: boolean = UPDATE_SIGNING_KEYS.keys.length > 0
