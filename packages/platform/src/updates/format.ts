/**
 * The format of a signed update: what is signed (the {@link UpdateStatement}) and how the
 * signature travels (the {@link SignatureEnvelope}, a small JSON file next to the artifact).
 *
 * The signature never covers the artifact directly. It covers a statement that names the
 * artifact's kind, version, file name, size and SHA-256, so one signature binds all of them:
 * a signed config can't pass for a module, an old version can't pass for a new one, and the
 * version is known before the (possibly large) artifact is downloaded.
 *
 * Node runs this file directly in the signing scripts (type stripping), so its imports spell
 * out `.ts` and it uses no `@fxm/core` code.
 *
 * @module
 */

import { concatBytes, fromBase64, fromUtf8, toBase64, utf8 } from './encoding.ts'

/** The `format` of every {@link SignatureEnvelope} this build reads. */
export const SIGNATURE_FORMAT = 'fxm-signed-update-1'

/**
 * Prepended to the statement before it is signed, so that a signature made for an FXM update
 * can never be valid for anything else the key might sign, and the other way round.
 */
export const SIGNATURE_CONTEXT = 'FXM signed update, format 1\n'

/** The signature file of an artifact is its file name plus this suffix. */
export const SIGNATURE_SUFFIX = '.sig'

/** The largest signature file read. */
export const MAX_SIGNATURE_BYTES = 4096

/** The largest statement read. */
export const MAX_STATEMENT_BYTES = 2048

/**
 * The highest version a statement may carry: 2^31 - 1, which every platform reads as a plain
 * integer. Versions start at 1 and go up by one per release, so this is never reached.
 */
export const MAX_VERSION = 2 ** 31 - 1

/** The largest JSON artifact, such as the YouTube config, apps accept by default: 256 KiB. */
export const DEFAULT_JSON_MAX_BYTES = 256 * 1024

/** The largest module, such as the YouTube resolver module, apps accept by default: 8 MiB. */
export const DEFAULT_CODE_MAX_BYTES = 8 * 1024 * 1024

/** An artifact kind, e.g. `youtube-config`. */
const KIND = /^[a-z][a-z0-9-]{1,39}$/u
/** A file name without a path, e.g. `youtube-module-1.js`. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
/** A key ID, e.g. `ed25519-0123456789abcdef`. */
const KEY_ID = /^[a-z0-9][a-z0-9:_-]{2,63}$/u
const SHA256 = /^[0-9a-f]{64}$/u
/** A git commit ID: SHA-1 (40 digits) or SHA-256 (64). */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
/** The largest artifact a statement may describe: 64 MiB. */
const MAX_SIZE = 64 * 1024 * 1024

/**
 * What a signature vouches for: one artifact, by kind, version, file name, size and SHA-256.
 * Its JSON is what the key signs (after {@link SIGNATURE_CONTEXT}).
 */
export interface UpdateStatement {
  /** What the artifact is, e.g. `youtube-config` or `youtube-module`. */
  readonly kind: string
  /**
   * Its version: a whole number from 1 to {@link MAX_VERSION} that increases with every release
   * of this kind, also across contracts and keys.
   */
  readonly version: number
  /**
   * The version of the contract the artifact follows, which is also in its file name: for code,
   * the contract between the app and the module; for data, its schema.
   */
  readonly api?: number
  /** The artifact's file name on the site, e.g. `youtube-module-1.js`. */
  readonly file: string
  /** Its length in bytes. */
  readonly size: number
  /** The SHA-256 of its bytes, in lower-case hexadecimal. */
  readonly sha256: string
  /**
   * The git commit it was built from, for people and for checks that rebuild it and compare
   * (`scripts/sign-update.mjs verify`). Apps don't read it.
   */
  readonly source?: string
  /** When it was signed, as an ISO 8601 time. For people only. */
  readonly signedAt: string
}

/** The signature file (`<file>.sig`): JSON with the statement and its signature. */
export interface SignatureEnvelope {
  /** Always {@link SIGNATURE_FORMAT}. */
  readonly format: typeof SIGNATURE_FORMAT
  /** Which key signed it (see `keyIdOf`). */
  readonly keyId: string
  /** The statement's exact UTF-8 JSON bytes, in Base64. */
  readonly statement: string
  /** The 64-byte Ed25519 signature of `SIGNATURE_CONTEXT + statement`, in Base64. */
  readonly signature: string
}

/** A signature file, read but not yet verified. */
export interface ParsedEnvelope {
  /** Which key signed it. */
  readonly keyId: string
  /** The statement's bytes, exactly as signed. */
  readonly statementBytes: Uint8Array<ArrayBuffer>
  /** The signature. */
  readonly signature: Uint8Array<ArrayBuffer>
}

/** A signature file or statement that does not follow this format. */
export class UpdateFormatError extends Error {
  override readonly name = 'UpdateFormatError'
}

function malformed(what: string): never {
  throw new UpdateFormatError(what)
}

function object(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(`${what} is not a JSON object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function field(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function json(bytes: Uint8Array, max: number, what: string): unknown {
  if (bytes.length > max) malformed(`${what} is larger than ${max} bytes`)
  let text: string
  try {
    text = fromUtf8(bytes)
  } catch {
    malformed(`${what} is not UTF-8`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    malformed(`${what} is not JSON`)
  }
}

function text(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) malformed(`${what} is invalid`)
  return value
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    malformed(`${what} must be a whole number from ${min} to ${max}`)
  }
  return value
}

/** Checks a statement's fields; unknown fields are ignored. */
function checkStatement(value: unknown): UpdateStatement {
  const record = object(value, 'The statement')
  const api = field(record, 'api')
  const source = field(record, 'source')
  const file = text(field(record, 'file'), FILE, 'The statement’s file')
  if (file.includes('..')) malformed('The statement’s file is invalid')
  const signedAt = field(record, 'signedAt')
  if (typeof signedAt !== 'string' || Number.isNaN(Date.parse(signedAt))) {
    malformed('The statement’s signedAt is not a time')
  }
  return {
    kind: text(field(record, 'kind'), KIND, 'The statement’s kind'),
    version: integer(field(record, 'version'), 1, MAX_VERSION, 'The version'),
    ...(api === undefined ? {} : { api: integer(api, 1, 1_000_000, 'The api') }),
    file,
    size: integer(field(record, 'size'), 0, MAX_SIZE, 'The size'),
    sha256: text(field(record, 'sha256'), SHA256, 'The statement’s sha256'),
    ...(source === undefined ? {} : { source: text(source, COMMIT, 'The statement’s source') }),
    signedAt,
  }
}

/**
 * The bytes a statement is signed as: compact JSON with the fields in a fixed order. Readers
 * never re-encode: they verify the exact bytes of the signature file.
 *
 * @throws UpdateFormatError when a field is invalid.
 */
export function encodeStatement(statement: UpdateStatement): Uint8Array<ArrayBuffer> {
  const checked = checkStatement(statement)
  const ordered = {
    kind: checked.kind,
    version: checked.version,
    ...(checked.api === undefined ? {} : { api: checked.api }),
    file: checked.file,
    size: checked.size,
    sha256: checked.sha256,
    ...(checked.source === undefined ? {} : { source: checked.source }),
    signedAt: checked.signedAt,
  }
  return utf8(JSON.stringify(ordered))
}

/**
 * Reads the statement of a verified signature file.
 *
 * @throws UpdateFormatError when it is not a statement in this format.
 */
export function parseStatement(bytes: Uint8Array): UpdateStatement {
  return checkStatement(json(bytes, MAX_STATEMENT_BYTES, 'The statement'))
}

/** What the key signs for `statementBytes`: {@link SIGNATURE_CONTEXT}, then the statement. */
export function signedMessage(statementBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(utf8(SIGNATURE_CONTEXT), statementBytes)
}

/** The signature file for a statement signed by `keyId`. */
export function encodeEnvelope(
  keyId: string,
  statementBytes: Uint8Array,
  signature: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const envelope: SignatureEnvelope = {
    format: SIGNATURE_FORMAT,
    keyId: text(keyId, KEY_ID, 'The key ID'),
    statement: toBase64(statementBytes),
    signature: toBase64(signature),
  }
  return utf8(`${JSON.stringify(envelope, null, 2)}\n`)
}

/**
 * Reads a signature file without verifying it: its key ID, the statement's exact bytes and the
 * signature.
 *
 * @throws UpdateFormatError when it is not a signature file in this format.
 */
export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  const record = object(json(bytes, MAX_SIGNATURE_BYTES, 'The signature file'), 'It')
  if (field(record, 'format') !== SIGNATURE_FORMAT) {
    malformed(`The signature file is not in the format ${SIGNATURE_FORMAT}`)
  }
  const keyId = text(field(record, 'keyId'), KEY_ID, 'The key ID')
  const statement = field(record, 'statement')
  const statementBytes = typeof statement === 'string' ? fromBase64(statement) : undefined
  if (statementBytes === undefined || statementBytes.length > MAX_STATEMENT_BYTES) {
    malformed('The signed statement is not Base64 of at most 2048 bytes')
  }
  const signature = field(record, 'signature')
  const signatureBytes = typeof signature === 'string' ? fromBase64(signature) : undefined
  if (signatureBytes?.length !== 64) malformed('The signature is not 64 bytes of Base64')
  return { keyId, statementBytes, signature: signatureBytes }
}
