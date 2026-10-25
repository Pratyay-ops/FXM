/**
 * Making signed updates: generating an Ed25519 key pair, and signing an artifact with the
 * private key. The owner runs this through `scripts/make-signing-key.sh`, `scripts/sign-config.sh`
 * and `scripts/sign-module.sh`; tests use it to sign with throwaway keys (`createTestSigner` in
 * `@fxm/platform/testing`). Apps never sign, so no package entry point exports it.
 *
 * It signs with WebCrypto's Ed25519 (`crypto.subtle`), which Node 22 has, and reads keys with
 * `@noble/curves`; nothing from Node itself. Node runs this file directly (type stripping), so
 * its imports spell out `.ts`.
 *
 * @module
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { keyIdOf, sha256Hex } from './digest.ts'
import { equalBytes, fromBase64, toBase64 } from './encoding.ts'
import {
  encodeEnvelope,
  encodeStatement,
  parseStatement,
  signedMessage,
  type UpdateStatement,
} from './format.ts'

/** WebCrypto's name for the algorithm. */
const ED25519 = { name: 'Ed25519' } as const

/** A private signing key, ready to sign. */
export interface SigningKey {
  /** The key's ID, as signature files name it (see {@link keyIdOf}). */
  readonly keyId: string
  /** The 32-byte public key. */
  readonly publicKey: Uint8Array<ArrayBuffer>
  /** The private key, which never leaves WebCrypto. */
  readonly privateKey: CryptoKey
}

/** A new key pair, as {@link generateSigningKey} returns it. */
export interface GeneratedKey {
  /** The key's ID. */
  readonly keyId: string
  /** The 32-byte public key. */
  readonly publicKey: Uint8Array<ArrayBuffer>
  /** The private key as PKCS #8 DER: keep it off the repository and off CI. */
  readonly pkcs8: Uint8Array<ArrayBuffer>
}

/** What to sign: an artifact's bytes and what it is. */
export interface SignInput {
  /** The artifact's kind, e.g. `youtube-config`. */
  readonly kind: string
  /** Its version; it must be higher than every version of this kind published before. */
  readonly version: number
  /** For code: the app-module contract version. */
  readonly api?: number
  /** Its file name on the site. */
  readonly file: string
  /** Its bytes, exactly as they will be published. */
  readonly bytes: Uint8Array
  /** The git commit it was built from, recorded in the statement. */
  readonly source?: string
  /** When it is signed; now by default. */
  readonly signedAt?: Date
}

/** A signed artifact's statement and signature file. */
export interface SignedUpdate {
  /** What the signature vouches for. */
  readonly statement: UpdateStatement
  /** The signature file's bytes (`<file>.sig`). */
  readonly envelope: Uint8Array<ArrayBuffer>
}

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
  if (crypto?.subtle === undefined) throw new Error('Signing needs WebCrypto (Node 22 or later)')
  return crypto.subtle
}

/**
 * The DER before the 32-byte seed in an Ed25519 private key as PKCS #8 (RFC 8410, section 7),
 * as WebCrypto and `openssl genpkey -algorithm ed25519` write it.
 */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/** Generates a new Ed25519 key pair for signing updates. */
export async function generateSigningKey(): Promise<GeneratedKey> {
  const pair = await subtle().generateKey(ED25519, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  return { keyId: keyIdOf(publicKey), publicKey, pkcs8 }
}

/**
 * A private key in PKCS #8 DER, imported for signing. WebCrypto keeps it as a key that can't be
 * exported again; the public key is derived from the seed, and checked by signing a test
 * message with the imported key.
 *
 * @throws Error when the bytes are not an Ed25519 private key in PKCS #8.
 */
export async function importSigningKey(pkcs8: Uint8Array): Promise<SigningKey> {
  const der = new Uint8Array(pkcs8)
  try {
    if (der.length !== PKCS8_PREFIX.length + 32 || !equalBytes(der.subarray(0, 16), PKCS8_PREFIX)) {
      throw new Error('Not an Ed25519 private key in PKCS #8 (RFC 8410)')
    }
    const publicKey = new Uint8Array(ed25519.getPublicKey(der.subarray(PKCS8_PREFIX.length)))
    const privateKey = await subtle().importKey('pkcs8', der, ED25519, false, ['sign'])
    const probe = new TextEncoder().encode('FXM signing key check')
    const signature = new Uint8Array(await subtle().sign(ED25519, privateKey, probe))
    if (!ed25519.verify(signature, probe, publicKey)) {
      throw new Error('The private key does not match the public key derived from it')
    }
    return { keyId: keyIdOf(publicKey), publicKey, privateKey }
  } finally {
    der.fill(0)
  }
}

const PEM_LABEL = 'PRIVATE KEY'

/** A PKCS #8 private key as PEM text, the format `openssl pkey` reads. */
export function pkcs8ToPem(pkcs8: Uint8Array): string {
  const lines = toBase64(pkcs8).match(/.{1,64}/gu) ?? []
  return `-----BEGIN ${PEM_LABEL}-----\n${lines.join('\n')}\n-----END ${PEM_LABEL}-----\n`
}

/**
 * The PKCS #8 DER bytes of a PEM private key.
 *
 * @throws Error when the text is not one PEM `PRIVATE KEY` block.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const match =
    /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/u.exec(
      pem.trim().concat('\n'),
    )
  const bytes = match?.[1] === undefined ? undefined : fromBase64(match[1].replace(/\s+/gu, ''))
  if (bytes === undefined) throw new Error('Not a PEM private key (-----BEGIN PRIVATE KEY-----)')
  return bytes
}

/**
 * Signs an artifact: builds its statement (kind, version, file, size, SHA-256) and signs it.
 * Publish the artifact's bytes unchanged, with the returned signature file next to it as
 * `<file>.sig`.
 *
 * @throws UpdateFormatError when an input is invalid, e.g. a version below 1 or a file name with
 * a path.
 */
export async function signUpdate(key: SigningKey, input: SignInput): Promise<SignedUpdate> {
  const statementBytes = encodeStatement({
    kind: input.kind,
    version: input.version,
    ...(input.api === undefined ? {} : { api: input.api }),
    file: input.file,
    size: input.bytes.length,
    sha256: sha256Hex(input.bytes),
    ...(input.source === undefined ? {} : { source: input.source }),
    signedAt: (input.signedAt ?? new Date()).toISOString(),
  })
  const signature = new Uint8Array(
    await subtle().sign(ED25519, key.privateKey, signedMessage(statementBytes)),
  )
  return {
    statement: parseStatement(statementBytes),
    envelope: encodeEnvelope(key.keyId, statementBytes, signature),
  }
}
