/**
 * What an FXM build trusts for signed updates: the public keys whose signatures it accepts, and
 * the versions withdrawn after release. Both are compiled into each build from
 * `update-keys.json`, so a hijacked site or a leaked deploy token can't change them: only an
 * app update can.
 *
 * Until the owner creates the real key pairs (`scripts/make-signing-key.sh`), the file holds a
 * placeholder that is not a key. A build with no valid key **fails closed**: it accepts no
 * signed update at all and uses the config and module it ships with.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { keyIdOf } from './digest.ts'
import { fromBase64 } from './encoding.ts'
import { MAX_VERSION } from './format.ts'
import keyFile from './update-keys.json'
import { isValidPublicKey, type TrustedKey } from './verify.ts'

/** Versions withdrawn after release, per artifact kind, e.g. `{ 'youtube-module': [4] }`. */
export type RevokedVersions = Readonly<Record<string, readonly number[]>>

/** What a build trusts, and why any entry was left out. */
export interface TrustedKeys {
  /** The valid keys. Empty means every signed update is refused. */
  readonly keys: readonly TrustedKey[]
  /**
   * Versions refused even when validly signed, per artifact kind: releases with a security bug,
   * which someone who controls the site could otherwise still serve to devices below them.
   */
  readonly revoked: RevokedVersions
  /** One line per entry that was left out, such as the placeholder. */
  readonly problems: readonly string[]
}

const KIND = /^[a-z][a-z0-9-]{1,39}$/u

function readRevoked(input: unknown, problems: string[]): RevokedVersions {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    problems.push('"revoked" is not an object of version lists')
    return {}
  }
  const revoked: Record<string, number[]> = {}
  for (const [kind, versions] of Object.entries(input)) {
    const valid =
      KIND.test(kind) &&
      Array.isArray(versions) &&
      versions.every(
        (version) => Number.isSafeInteger(version) && version >= 1 && version <= MAX_VERSION,
      )
    if (valid) revoked[kind] = [...versions]
    else problems.push(`The revoked versions of ${kind} are not a list of versions`)
  }
  return revoked
}

/**
 * Reads what a build trusts, in the format of `update-keys.json`: `{ keys: [{ keyId, publicKey
 * }], revoked: { <kind>: [<version>, …] } }`, with each `publicKey` in Base64. A key is kept only
 * when it is valid ({@link isValidPublicKey}) and its `keyId` is the key's own ID
 * ({@link keyIdOf}), so a typo can't slip through.
 */
export function parseTrustedKeys(input: unknown): TrustedKeys {
  const record = (input ?? {}) as { keys?: unknown; revoked?: unknown }
  const problems: string[] = []
  const revoked = readRevoked(record.revoked, problems)
  if (!Array.isArray(record.keys)) {
    return { keys: [], revoked, problems: ['The key list has no "keys" array', ...problems] }
  }
  const keys: TrustedKey[] = []
  for (const [index, entry] of record.keys.entries()) {
    const { keyId, publicKey } = (entry ?? {}) as { keyId?: unknown; publicKey?: unknown }
    const name = typeof keyId === 'string' ? keyId : `entry ${index}`
    const bytes = typeof publicKey === 'string' ? fromBase64(publicKey) : undefined
    if (bytes === undefined || !isValidPublicKey(bytes)) {
      problems.push(`${name} is not an Ed25519 public key`)
    } else if (keyId !== keyIdOf(bytes)) {
      problems.push(`${name} should have the ID ${keyIdOf(bytes)}`)
    } else if (keys.some((key) => key.keyId === keyId)) {
      problems.push(`${name} is listed twice`)
    } else {
      keys.push({ keyId, publicKey: bytes })
    }
  }
  return { keys, revoked, problems }
}

/**
 * Checks keys that reach the updater some other way than {@link parseTrustedKeys}, e.g. from a
 * test or a later stage's settings: each must be a valid Ed25519 public key, listed once under
 * its own ID.
 *
 * @throws FxmError `Unsupported` naming the first key that is not.
 */
export function checkTrustedKeys(keys: readonly TrustedKey[]): void {
  const seen = new Set<string>()
  for (const key of keys) {
    const name = typeof key?.keyId === 'string' ? key.keyId : 'A key'
    if (!isValidPublicKey(key?.publicKey)) {
      throw new FxmError('Unsupported', `${name} is not a valid Ed25519 public key`)
    }
    if (key.keyId !== keyIdOf(key.publicKey)) {
      throw new FxmError('Unsupported', `${name} should have the ID ${keyIdOf(key.publicKey)}`)
    }
    if (seen.has(key.keyId)) throw new FxmError('Unsupported', `${name} is listed twice`)
    seen.add(key.keyId)
  }
}

/** What this build trusts, from `update-keys.json`. */
export const UPDATE_SIGNING_KEYS: TrustedKeys = parseTrustedKeys(keyFile)

/**
 * Whether this build trusts at least one real key. `false` while `update-keys.json` holds only
 * the placeholder: such a build refuses every signed update, and a release job can check this
 * to refuse to ship it.
 */
export const UPDATE_SIGNING_READY: boolean = UPDATE_SIGNING_KEYS.keys.length > 0
