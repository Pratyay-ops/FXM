/**
 * The desktop updater's keys and signatures: minisign's formats (Ed25519), as the Tauri CLI writes
 * them (`tauri signer generate`, `tauri signer sign`) and tauri-plugin-updater reads them, with
 * nothing but Node's own crypto.
 *
 * - A **public key** is the text of a minisign `.pub` file, base64-encoded once more: what
 *   `plugins > updater > pubkey` in `tauri.conf.json` holds.
 * - A **secret key** is a minisign secret key file, base64-encoded the same way, its key encrypted
 *   with scrypt from the password: what `TAURI_SIGNING_PRIVATE_KEY` and
 *   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` hold.
 * - A **signature** is the text of a minisign `.sig` file, base64-encoded: what the CLI writes to
 *   a `.sig` file and `latest.json` carries for each platform. It signs the file's BLAKE2b-512
 *   hash, and its trusted comment `timestamp:<unix>\tfile:<name>\tversion:<x.y.z>` is signed as
 *   well, so the updater (`requireSignedVersion`) can check which version a file was released as.
 *
 * The release workflow signs with this module rather than with the CLI, so the job that holds the
 * updater key runs no code but Node and FXM's own (`release.ts`).
 *
 * Formats from the minisign crate 0.9.1 (`secret_key.rs`, `signature_box.rs`, `helpers.rs`),
 * which the Tauri CLI 2.12 uses, and minisign-verify 0.3.0, which tauri-plugin-updater 2.13 uses.
 *
 * @module
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  scryptSync,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from 'node:crypto'
import { blake2b } from './blake2b.ts'

/** A public key: its id and its Ed25519 key. */
export interface PublicKey {
  /** The key id: eight random bytes, the same in the secret key and in every signature. */
  readonly keyId: Buffer
  /** The 32-byte Ed25519 public key. */
  readonly key: Buffer
}

/** A decrypted secret key. */
export interface SecretKey extends PublicKey {
  /** The 32-byte Ed25519 seed. */
  readonly seed: Buffer
}

/** Ed25519 without prehashing: minisign's legacy signatures, which only verification accepts. */
const SIG_ALG = Buffer.from('Ed')
/** Ed25519 over the BLAKE2b-512 hash of the file: every signature this module makes. */
const SIG_ALG_PREHASHED = Buffer.from('ED')
/** scrypt, the key derivation that encrypts a secret key. */
const KDF_SCRYPT = Buffer.from('Sc')
/** No key derivation: an unencrypted secret key, which the Tauri CLI refuses, and so does this. */
const KDF_NONE = Buffer.from([0, 0])
/** BLAKE2b-256, the checksum that tells a wrong password. */
const CHK_ALG = Buffer.from('B2')

const KEY_ID_BYTES = 8
const SEED_BYTES = 32
const PUBLIC_KEY_BYTES = 32
const SECRET_KEY_BYTES = SEED_BYTES + PUBLIC_KEY_BYTES
const CHECKSUM_BYTES = 32
const SALT_BYTES = 32
const SIGNATURE_BYTES = 64
/** The encrypted part of a secret key: its id, the key and the checksum. */
const KEYNUM_BYTES = KEY_ID_BYTES + SECRET_KEY_BYTES + CHECKSUM_BYTES

/** minisign's scrypt costs for new keys (`OPSLIMIT`, `MEMLIMIT`), and its limits. */
export const SCRYPT_OPSLIMIT = 1_048_576
export const SCRYPT_MEMLIMIT = 33_554_432
const SCRYPT_MEMLIMIT_MAX = 1_073_741_824
const SCRYPT_N_LOG2_MAX = 20

const COMMENT_PREFIX = 'untrusted comment: '
const TRUSTED_COMMENT_PREFIX = 'trusted comment: '
/** The untrusted comment the Tauri CLI writes into its signatures. */
const SIGNATURE_COMMENT = 'signature from tauri secret key'

/** DER prefixes that wrap a raw Ed25519 seed (PKCS #8) or public key (SPKI) for Node's crypto. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

/** Decodes standard base64, refusing anything else: Node's own decoder skips stray characters. */
export function strictBase64(text: string, what: string): Buffer {
  const trimmed = text.trim()
  if (trimmed === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error(`${what} is not base64`)
  }
  return Buffer.from(trimmed, 'base64')
}

/** The lines of a decoded key or signature file, without the line breaks. */
function linesOf(base64: string, what: string): string[] {
  return strictBase64(base64, what).toString('utf8').split(/\r?\n/)
}

/** The key id as minisign prints it: the eight bytes as a little-endian number, in hex. */
export function keyIdHex(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase()
}

function ed25519PrivateKey(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

function ed25519PublicKey(key: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: 'der', type: 'spki' })
}

/** The Ed25519 public key of a seed. */
function publicKeyOf(seed: Buffer): Buffer {
  const spki = createPublicKey(ed25519PrivateKey(seed)).export({ format: 'der', type: 'spki' })
  return Buffer.from(spki.subarray(SPKI_ED25519.length))
}

/** Decodes a public key as `tauri.conf.json` holds it. Throws on anything else. */
export function decodePublicKey(base64: string): PublicKey {
  const [comment, encoded] = linesOf(base64, 'The updater public key')
  if (!comment?.startsWith(COMMENT_PREFIX) || encoded === undefined) {
    throw new Error('The updater public key is not a minisign public key')
  }
  const bytes = strictBase64(encoded, 'The updater public key')
  if (
    bytes.length !== 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES ||
    !bytes.subarray(0, 2).equals(SIG_ALG)
  ) {
    throw new Error('The updater public key is not an Ed25519 minisign key')
  }
  return { keyId: bytes.subarray(2, 2 + KEY_ID_BYTES), key: bytes.subarray(2 + KEY_ID_BYTES) }
}

/** Encodes a public key as the Tauri CLI writes it to `<key>.pub`. */
export function encodePublicKey(key: PublicKey): string {
  const encoded = Buffer.concat([SIG_ALG, key.keyId, key.key]).toString('base64')
  const text = `${COMMENT_PREFIX}minisign public key: ${keyIdHex(key.keyId)}\n${encoded}\n`
  return Buffer.from(text).toString('base64')
}

/**
 * scrypt's N (as log2), r and p from minisign's costs: libsodium's `pickparams`, as the minisign
 * crate ports it (`raw_scrypt_params`).
 */
export function scryptParams(opslimit: number, memlimit: number) {
  if (memlimit > SCRYPT_MEMLIMIT_MAX) throw new Error('The key asks for too much memory')
  const ops = Math.max(32768, opslimit)
  const r = 8
  let nLog2 = 1
  let p: number
  const fitsIn = (maxN: number) => {
    while (nLog2 < 63 && 2 ** nLog2 <= Math.floor(maxN / 2)) nLog2++
  }
  if (ops < Math.floor(memlimit / 32)) {
    p = 1
    fitsIn(Math.floor(ops / (r * 4)))
  } else {
    fitsIn(Math.floor(memlimit / (r * 128)))
    const maxRp = Math.min(0x3fffffff, Math.floor(Math.floor(ops / 4) / 2 ** nLog2))
    p = Math.floor(maxRp / r)
  }
  if (nLog2 > SCRYPT_N_LOG2_MAX || p < 1) throw new Error('The key asks for unusable scrypt costs')
  return { nLog2, r, p }
}

/** The stream that encrypts and decrypts a secret key's id, key and checksum. */
function keyStream(password: string, salt: Buffer, opslimit: number, memlimit: number): Buffer {
  const { nLog2, r, p } = scryptParams(opslimit, memlimit)
  const N = 2 ** nLog2
  return scryptSync(Buffer.from(password, 'utf8'), salt, KEYNUM_BYTES, {
    N,
    r,
    p,
    maxmem: 128 * N * r * (p + 1) + 1024 * 1024,
  })
}

const xor = (bytes: Buffer, stream: Buffer) =>
  Buffer.from(bytes.map((byte, index) => byte ^ (stream[index] ?? 0)))

function checksum(keyId: Buffer, secretKey: Buffer): Buffer {
  return Buffer.from(blake2b(Buffer.concat([SIG_ALG, keyId, secretKey]), CHECKSUM_BYTES))
}

/**
 * Decodes and decrypts a secret key as `TAURI_SIGNING_PRIVATE_KEY` holds it, with its password
 * (empty when it has none). Throws on a wrong password or a damaged key, as the Tauri CLI does.
 */
export function decodeSecretKey(base64: string, password: string): SecretKey {
  const [comment, encoded] = linesOf(base64, 'The updater secret key')
  if (!comment?.startsWith(COMMENT_PREFIX) || encoded === undefined) {
    throw new Error('The updater secret key is not a minisign secret key')
  }
  const bytes = strictBase64(encoded, 'The updater secret key')
  if (bytes.length !== 6 + SALT_BYTES + 16 + KEYNUM_BYTES) {
    throw new Error('The updater secret key has the wrong length')
  }
  let offset = 0
  const take = (length: number) => {
    const part = bytes.subarray(offset, offset + length)
    offset += length
    return part
  }
  const sigAlg = take(2)
  const kdfAlg = take(2)
  const chkAlg = take(2)
  const salt = take(SALT_BYTES)
  const opslimit = Number(take(8).readBigUInt64LE())
  const memlimit = Number(take(8).readBigUInt64LE())
  const encrypted = take(KEYNUM_BYTES)
  if (!sigAlg.equals(SIG_ALG) || !chkAlg.equals(CHK_ALG)) {
    throw new Error('The updater secret key is not an Ed25519 minisign key')
  }
  if (kdfAlg.equals(KDF_NONE)) {
    throw new Error('The updater secret key is not encrypted, which the Tauri CLI refuses too')
  }
  if (!kdfAlg.equals(KDF_SCRYPT)) throw new Error('The updater secret key uses an unknown cipher')
  const keynum = xor(encrypted, keyStream(password, salt, opslimit, memlimit))
  const keyId = keynum.subarray(0, KEY_ID_BYTES)
  const secret = keynum.subarray(KEY_ID_BYTES, KEY_ID_BYTES + SECRET_KEY_BYTES)
  const stored = keynum.subarray(KEY_ID_BYTES + SECRET_KEY_BYTES)
  if (!timingSafeEqual(checksum(keyId, secret), stored)) {
    throw new Error('Wrong password for the updater secret key')
  }
  const seed = secret.subarray(0, SEED_BYTES)
  const key = secret.subarray(SEED_BYTES)
  if (!publicKeyOf(seed).equals(key)) throw new Error('The updater secret key is damaged')
  return { keyId, seed, key }
}

/** Encrypts a secret key with `password` and encodes it as the Tauri CLI writes it. */
export function encodeSecretKey(key: SecretKey, password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const secret = Buffer.concat([key.seed, key.key])
  const keynum = Buffer.concat([key.keyId, secret, checksum(key.keyId, secret)])
  const limits = Buffer.alloc(16)
  limits.writeBigUInt64LE(BigInt(SCRYPT_OPSLIMIT), 0)
  limits.writeBigUInt64LE(BigInt(SCRYPT_MEMLIMIT), 8)
  const encrypted = xor(keynum, keyStream(password, salt, SCRYPT_OPSLIMIT, SCRYPT_MEMLIMIT))
  const encoded = Buffer.concat([SIG_ALG, KDF_SCRYPT, CHK_ALG, salt, limits, encrypted])
  const text = `${COMMENT_PREFIX}rsign encrypted secret key\n${encoded.toString('base64')}\n`
  return Buffer.from(text).toString('base64')
}

/** A new key pair, its secret key encrypted with `password`: what `tauri signer generate` makes. */
export function generateKeyPair(password: string): { publicKey: string; secretKey: string } {
  const seed = randomBytes(SEED_BYTES)
  const key: SecretKey = { keyId: randomBytes(KEY_ID_BYTES), seed, key: publicKeyOf(seed) }
  return { publicKey: encodePublicKey(key), secretKey: encodeSecretKey(key, password) }
}

/** Whether a public key and a decrypted secret key belong together. */
export function samePublicKey(a: PublicKey, b: PublicKey): boolean {
  return a.keyId.equals(b.keyId) && a.key.equals(b.key)
}

/**
 * The trusted comment of a release file's signature, as the Tauri CLI writes it: the time, the
 * file's name and the version it is released as.
 */
export function trustedComment(fileName: string, version: string, timestamp: number): string {
  for (const [what, value] of [
    ['file name', fileName],
    ['version', version],
  ]) {
    if (/[\t\r\n]/.test(value ?? '')) throw new Error(`The ${what} ${value} has a tab or a newline`)
  }
  return `timestamp:${Math.floor(timestamp)}\tfile:${fileName}\tversion:${version}`
}

/** Signs `data` with the trusted comment: the base64 text of a `.sig` file. */
export function sign(data: Uint8Array, key: SecretKey, comment: string): string {
  if (/[\r\n]/.test(comment)) throw new Error('A trusted comment is one line')
  const privateKey = ed25519PrivateKey(key.seed)
  const digest = createHash('blake2b512').update(data).digest()
  const signature = signBytes(null, digest, privateKey)
  const global = signBytes(
    null,
    Buffer.concat([signature, Buffer.from(comment, 'utf8')]),
    privateKey,
  )
  const text = [
    `${COMMENT_PREFIX}${SIGNATURE_COMMENT}`,
    Buffer.concat([SIG_ALG_PREHASHED, key.keyId, signature]).toString('base64'),
    `${TRUSTED_COMMENT_PREFIX}${comment}`,
    global.toString('base64'),
    '',
  ].join('\n')
  return Buffer.from(text).toString('base64')
}

/**
 * Checks a signature of `data` as tauri-plugin-updater does (minisign-verify, legacy signatures
 * allowed) and returns its trusted comment. Throws when it doesn't hold.
 */
export function verify(data: Uint8Array, signature: string, publicKey: PublicKey): string {
  const [, encoded, comment, encodedGlobal] = linesOf(signature, 'The signature')
  if (encoded === undefined || comment === undefined || encodedGlobal === undefined) {
    throw new Error('The signature is not a minisign signature')
  }
  const bytes = strictBase64(encoded, 'The signature')
  const global = strictBase64(encodedGlobal, 'The signature')
  if (bytes.length !== 2 + KEY_ID_BYTES + SIGNATURE_BYTES || global.length !== SIGNATURE_BYTES) {
    throw new Error('The signature has the wrong length')
  }
  if (!comment.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error('The signature has no trusted comment')
  }
  const algorithm = bytes.subarray(0, 2)
  const prehashed = algorithm.equals(SIG_ALG_PREHASHED)
  if (!prehashed && !algorithm.equals(SIG_ALG)) {
    throw new Error('The signature uses an unknown algorithm')
  }
  if (!bytes.subarray(2, 2 + KEY_ID_BYTES).equals(publicKey.keyId)) {
    throw new Error(`The signature was made with another key than ${keyIdHex(publicKey.keyId)}`)
  }
  const raw = bytes.subarray(2 + KEY_ID_BYTES)
  const trusted = comment.slice(TRUSTED_COMMENT_PREFIX.length)
  const key = ed25519PublicKey(publicKey.key)
  const message = prehashed ? createHash('blake2b512').update(data).digest() : data
  if (!verifyBytes(null, message, key, raw))
    throw new Error('The signature does not match the file')
  if (!verifyBytes(null, Buffer.concat([raw, Buffer.from(trusted, 'utf8')]), key, global)) {
    throw new Error('The signature does not match its trusted comment')
  }
  return trusted
}

/** The version a trusted comment names, as tauri-plugin-updater reads it. */
export function signedVersion(comment: string): string | undefined {
  for (const field of comment.split('\t')) {
    if (field.startsWith('version:')) return field.slice('version:'.length)
  }
  return undefined
}
