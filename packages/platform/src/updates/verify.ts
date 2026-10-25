/**
 * Verifying signed updates: the Ed25519 signature of a statement, the statement against what
 * the app expects, and the artifact's bytes against the statement.
 *
 * Signatures are checked with WebCrypto's Ed25519 where the platform has it, and otherwise
 * with `@noble/curves` (MIT, audited), in pure JavaScript. WebCrypto has Ed25519 in Chrome,
 * Edge, WebView2 and Android System WebView 137, Firefox 129 and Safari 17 (macOS 12.6 and
 * later); older WebViews, such as WKWebView on macOS 11 and some WebKitGTK builds, use the
 * library. A known-answer test (RFC 8032, test 2) decides which, once.
 *
 * @module
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256Hex } from './digest.ts'
import { fromHex } from './encoding.ts'
import {
  parseEnvelope,
  parseStatement,
  SIGNATURE_SUFFIX,
  signedMessage,
  type UpdateStatement,
} from './format.ts'
import type { TrustedKey } from './keys.ts'

/** How a signature was checked: WebCrypto's Ed25519, or the JavaScript library. */
export type VerifierEngine = 'webcrypto' | 'noble'

/** Checks Ed25519 signatures. */
export interface SignatureVerifier {
  /**
   * Whether `signature` is `key`'s valid signature of `message`. Never throws: anything
   * malformed is simply not valid.
   */
  verify(key: TrustedKey, message: Uint8Array, signature: Uint8Array): Promise<boolean>
  /** Which engine this platform uses, after the known-answer test. */
  engine(): Promise<VerifierEngine>
}

/** Options for {@link createSignatureVerifier}. */
export interface VerifierOptions {
  /**
   * The WebCrypto to try first; `null` to use only the library. Default: the global
   * `crypto.subtle`, where there is one (it needs a secure context in browsers).
   */
  subtle?: SubtleCrypto | null
}

const ED25519 = { name: 'Ed25519' } as const

/**
 * RFC 8032, section 7.1, test 2: a one-byte message. Not test 1, whose message is empty: WebKit's
 * Ed25519 refuses that valid signature (Safari and WKWebView, measured 2026-10-26), though it
 * verifies every non-empty message, and FXM never signs an empty one.
 */
const KNOWN_ANSWER = {
  publicKey: fromHex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
  message: fromHex('72'),
  signature: fromHex(
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  ),
} as const

function globalSubtle(): SubtleCrypto | null {
  try {
    return (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle ?? null
  } catch {
    return null
  }
}

/** A copy whose buffer WebCrypto accepts as a `BufferSource`. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

/** Whether `subtle` verifies Ed25519 correctly: accepts the known answer, refuses a forgery. */
async function webCryptoWorks(subtle: SubtleCrypto): Promise<boolean> {
  const { publicKey, message, signature } = KNOWN_ANSWER
  if (publicKey === undefined || message === undefined || signature === undefined) return false
  try {
    const key = await subtle.importKey('raw', buffer(publicKey), ED25519, false, ['verify'])
    const forged = buffer(signature)
    forged[0] = (forged[0] ?? 0) ^ 1
    return (
      (await subtle.verify(ED25519, key, buffer(signature), buffer(message))) &&
      !(await subtle.verify(ED25519, key, forged, buffer(message)))
    )
  } catch {
    return false
  }
}

/**
 * Creates a signature verifier that uses WebCrypto's Ed25519 when the platform's passes the
 * known-answer test, and `@noble/curves` otherwise, in the strict RFC 8032 mode (no ZIP-215
 * leniency). Keys reach it already validated (`isValidPublicKey`), so small-order keys never do.
 */
export function createSignatureVerifier(options: VerifierOptions = {}): SignatureVerifier {
  const subtle = options.subtle === undefined ? globalSubtle() : options.subtle
  let detected: Promise<VerifierEngine> | undefined
  const imported = new Map<string, Promise<CryptoKey>>()

  function engine(): Promise<VerifierEngine> {
    detected ??=
      subtle === null
        ? Promise.resolve('noble')
        : webCryptoWorks(subtle).then((works) => (works ? 'webcrypto' : 'noble'))
    return detected
  }

  function cryptoKey(webCrypto: SubtleCrypto, key: TrustedKey): Promise<CryptoKey> {
    let promise = imported.get(key.id)
    if (promise === undefined) {
      promise = webCrypto.importKey('raw', buffer(key.publicKey), ED25519, false, ['verify'])
      imported.set(key.id, promise)
    }
    return promise
  }

  return {
    engine,
    async verify(key, message, signature) {
      if (signature.length !== 64 || key.publicKey.length !== 32) return false
      if (subtle !== null && (await engine()) === 'webcrypto') {
        try {
          const webKey = await cryptoKey(subtle, key)
          return await subtle.verify(ED25519, webKey, buffer(signature), buffer(message))
        } catch {
          imported.delete(key.id)
          // An unexpected WebCrypto failure: the library decides instead.
        }
      }
      try {
        return ed25519.verify(signature, message, key.publicKey, { zip215: false })
      } catch {
        return false
      }
    },
  }
}

/** Why a signature file or an artifact was refused. */
export type VerificationFailure =
  /** The signature file or its statement is not in the expected format. */
  | 'malformed'
  /** It names a key this build does not trust. */
  | 'unknown-key'
  /** The signature is not valid for the statement and the named key. */
  | 'bad-signature'
  /** Validly signed, but for another kind, file or app-module contract. */
  | 'wrong-artifact'
  /** The artifact is larger than this build accepts for its kind. */
  | 'too-large'
  /** The artifact's bytes don't match the signed size and SHA-256. */
  | 'hash-mismatch'

/** What an artifact must be for the app to take it. */
export interface ArtifactExpectation {
  /** Its kind, e.g. `youtube-module`. */
  readonly kind: string
  /** Its file name, e.g. `youtube-module-1.js`. */
  readonly file: string
  /** For code: the app-module contract version this build speaks. */
  readonly api?: number
  /** The largest artifact this build accepts for this kind. */
  readonly maxBytes: number
}

/** Why a check failed. */
export interface VerificationError {
  readonly ok: false
  /** The reason, for the report. */
  readonly failure: VerificationFailure
  /** Details, for logs. */
  readonly message: string
}

/** The outcome of a check: the signed statement and its key, or why it failed. */
export type VerificationResult =
  | { readonly ok: true; readonly statement: UpdateStatement; readonly keyId: string }
  | VerificationError

function failed(failure: VerificationFailure, message: string): VerificationError {
  return { ok: false, failure, message }
}

/**
 * Checks a signature file (`<file>.sig`): its format, that a trusted key signed its statement,
 * and that the statement is about the expected artifact. It says nothing about versions: the
 * updater compares those.
 */
export async function verifySignatureFile(
  bytes: Uint8Array,
  expected: ArtifactExpectation,
  keys: readonly TrustedKey[],
  verifier: SignatureVerifier,
): Promise<VerificationResult> {
  let envelope: ReturnType<typeof parseEnvelope>
  try {
    envelope = parseEnvelope(bytes)
  } catch (error) {
    return failed('malformed', (error as Error).message)
  }
  const key = keys.find((candidate) => candidate.id === envelope.keyId)
  if (key === undefined) {
    return failed('unknown-key', `${expected.file}${SIGNATURE_SUFFIX} is signed by an unknown key`)
  }
  const message = signedMessage(envelope.statementBytes)
  if (!(await verifier.verify(key, message, envelope.signature))) {
    return failed('bad-signature', `The signature of ${expected.file} is not valid`)
  }
  let statement: UpdateStatement
  try {
    statement = parseStatement(envelope.statementBytes)
  } catch (error) {
    return failed('malformed', (error as Error).message)
  }
  if (statement.kind !== expected.kind || statement.file !== expected.file) {
    return failed(
      'wrong-artifact',
      `The signature is for ${statement.kind} ${statement.file}, not ${expected.kind} ${expected.file}`,
    )
  }
  if (statement.api !== expected.api) {
    return failed(
      'wrong-artifact',
      `The signature is for contract ${statement.api ?? 'none'}, not ${expected.api ?? 'none'}`,
    )
  }
  if (statement.size > expected.maxBytes) {
    return failed('too-large', `${expected.file} is ${statement.size} bytes, over the limit`)
  }
  return { ok: true, statement, keyId: key.id }
}

/**
 * Checks an artifact's bytes against its signed statement: the size, then the SHA-256.
 * Returns `undefined` when they match.
 */
export function checkArtifactBytes(
  bytes: Uint8Array,
  statement: UpdateStatement,
): VerificationError | undefined {
  if (bytes.length !== statement.size || sha256Hex(bytes) !== statement.sha256) {
    return failed('hash-mismatch', `${statement.file} does not match its signature`)
  }
  return undefined
}
