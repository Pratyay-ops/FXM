/**
 * Making signed updates: generating the Ed25519 key pair, and signing an artifact with the
 * private key. The owner runs this through `scripts/make-signing-key.sh`, `scripts/sign-config.sh`
 * and `scripts/sign-module.sh`; tests use it to sign with throwaway keys. Apps never sign.
 *
 * It uses WebCrypto's Ed25519 (`crypto.subtle`), which Node 22 has, and nothing from Node
 * itself. Node runs this file directly (type stripping), so its imports spell out `.ts`.
 *
 * @module
 */

import { keyIdOf, sha256Hex } from './digest.ts'
import { fromBase64, toBase64 } from './encoding.ts'
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

/** The raw public key of a WebCrypto Ed25519 key: `x` of its JWK, or its raw export. */
async function publicKeyOf(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = await subtle().exportKey('jwk', key)
  const x = typeof jwk.x === 'string' ? jwk.x.replaceAll('-', '+').replaceAll('_', '/') : ''
  const bytes = fromBase64(x.padEnd(Math.ceil(x.length / 4) * 4, '='))
  if (bytes?.length !== 32) throw new Error('The key has no 32-byte Ed25519 public key')
  return bytes
}

/** Generates a new Ed25519 key pair for signing updates. */
export async function generateSigningKey(): Promise<GeneratedKey> {
  const pair = await subtle().generateKey(ED25519, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  return { keyId: keyIdOf(publicKey), publicKey, pkcs8 }
}

/** A private key in PKCS #8 DER, imported for signing. */
export async function importSigningKey(pkcs8: Uint8Array): Promise<SigningKey> {
  const der = new Uint8Array(pkcs8)
  const privateKey = await subtle().importKey('pkcs8', der, ED25519, true, ['sign'])
  const publicKey = await publicKeyOf(privateKey)
  return { keyId: keyIdOf(publicKey), publicKey, privateKey }
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
