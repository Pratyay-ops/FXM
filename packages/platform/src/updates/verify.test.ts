import { ed25519 } from '@noble/curves/ed25519.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { keyIdOf, sha256Hex } from './digest.ts'
import { fromUtf8, toBase64, utf8 } from './encoding.ts'
import { encodeEnvelope, encodeStatement, parseEnvelope, signedMessage } from './format.ts'
import type { TrustedKey } from './keys.ts'
import {
  generateSigningKey,
  importSigningKey,
  pemToPkcs8,
  pkcs8ToPem,
  type SigningKey,
  signUpdate,
} from './sign.ts'
import { createTestSigner, type TestSigner } from './testing.ts'
import {
  type ArtifactExpectation,
  checkArtifactBytes,
  createSignatureVerifier,
  type SignatureVerifier,
  verifySignatureFile,
} from './verify.ts'

const MODULE: ArtifactExpectation = {
  kind: 'youtube-module',
  file: 'youtube-module-1.js',
  api: 1,
  maxBytes: 1024,
}
const BYTES = utf8('export const youtubeModule = {}')

let signer: TestSigner
let other: TestSigner

beforeAll(async () => {
  signer = await createTestSigner()
  other = await createTestSigner()
})

/** Both engines, so every case runs with WebCrypto and with the library. */
const ENGINES: readonly [string, () => SignatureVerifier][] = [
  ['WebCrypto', () => createSignatureVerifier()],
  ['@noble/curves', () => createSignatureVerifier({ subtle: null })],
]

/** A signed module statement; `api: undefined` leaves the contract version out. */
async function signedModule(
  change: { kind?: string; file?: string; api?: number | undefined; bytes?: Uint8Array } = {},
) {
  const api = 'api' in change ? change.api : 1
  return signer.sign({
    kind: change.kind ?? 'youtube-module',
    version: 2,
    file: change.file ?? MODULE.file,
    bytes: change.bytes ?? BYTES,
    ...(api === undefined ? {} : { api }),
  })
}

describe('signing keys', () => {
  it('generates a key pair whose ID is derived from the public key', async () => {
    const generated = await generateSigningKey()
    expect(generated.publicKey).toHaveLength(32)
    expect(generated.keyId).toBe(keyIdOf(generated.publicKey))
    expect(generated.keyId).toMatch(/^ed25519-[0-9a-f]{16}$/)
    const imported = await importSigningKey(generated.pkcs8)
    expect(imported.keyId).toBe(generated.keyId)
    expect(imported.publicKey).toEqual(generated.publicKey)
  })

  it('writes and reads private keys as PKCS #8 PEM', async () => {
    const generated = await generateSigningKey()
    const pem = pkcs8ToPem(generated.pkcs8)
    expect(pem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/,
    )
    expect(pemToPkcs8(pem)).toEqual(generated.pkcs8)
    expect(pemToPkcs8(`\n${pem.replaceAll('\n', '\r\n')}  `)).toEqual(generated.pkcs8)
    expect(() => pemToPkcs8('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')).toThrow(
      /PEM private key/,
    )
  })

  it('signs a statement with the size and SHA-256 of the bytes', async () => {
    const signed = await signedModule()
    expect(signed.statement).toMatchObject({
      kind: 'youtube-module',
      version: 2,
      api: 1,
      file: MODULE.file,
      size: BYTES.length,
      sha256: sha256Hex(BYTES),
    })
    const parsed = parseEnvelope(signed.envelope)
    expect(parsed.keyId).toBe(signer.trusted.id)
    expect(fromUtf8(signed.envelope)).toContain('"format": "fxm-signed-update-1"')
  })

  it('signs the context-prefixed statement with plain Ed25519', async () => {
    const parsed = parseEnvelope((await signedModule()).envelope)
    const message = signedMessage(parsed.statementBytes)
    expect(ed25519.verify(parsed.signature, message, signer.trusted.publicKey)).toBe(true)
    expect(ed25519.verify(parsed.signature, parsed.statementBytes, signer.trusted.publicKey)).toBe(
      false,
    )
  })
})

describe.each(ENGINES)('verifySignatureFile with %s', (_, makeVerifier) => {
  let verifier: SignatureVerifier
  let keys: TrustedKey[]

  beforeAll(() => {
    verifier = makeVerifier()
    keys = [signer.trusted]
  })

  it('accepts a valid signature and returns the statement', async () => {
    const signed = await signedModule()
    const result = await verifySignatureFile(signed.envelope, MODULE, keys, verifier)
    expect(result).toEqual({ ok: true, statement: signed.statement, keyId: signer.trusted.id })
  })

  it('refuses a signature by a key the build does not trust', async () => {
    const signed = await other.sign({
      kind: 'youtube-module',
      version: 9,
      api: 1,
      file: MODULE.file,
      bytes: BYTES,
    })
    const result = await verifySignatureFile(signed.envelope, MODULE, keys, verifier)
    expect(result).toMatchObject({ ok: false, failure: 'unknown-key' })
  })

  it('refuses a signature made by another key under the trusted key ID', async () => {
    const forged = await other.sign({
      kind: 'youtube-module',
      version: 9,
      api: 1,
      file: MODULE.file,
      bytes: BYTES,
    })
    const parsed = parseEnvelope(forged.envelope)
    const relabelled = encodeEnvelope(signer.trusted.id, parsed.statementBytes, parsed.signature)
    const result = await verifySignatureFile(relabelled, MODULE, keys, verifier)
    expect(result).toMatchObject({ ok: false, failure: 'bad-signature' })
  })

  it('refuses a statement changed after signing, e.g. a raised version', async () => {
    const parsed = parseEnvelope((await signedModule()).envelope)
    const raised = utf8(fromUtf8(parsed.statementBytes).replace('"version":2', '"version":9'))
    const tampered = encodeEnvelope(signer.trusted.id, raised, parsed.signature)
    const result = await verifySignatureFile(tampered, MODULE, keys, verifier)
    expect(result).toMatchObject({ ok: false, failure: 'bad-signature' })
  })

  it('refuses a flipped signature bit and an all-zero signature', async () => {
    const parsed = parseEnvelope((await signedModule()).envelope)
    const flipped = new Uint8Array(parsed.signature)
    flipped[10] = (flipped[10] ?? 0) ^ 0x40
    for (const signature of [flipped, new Uint8Array(64)]) {
      const tampered = encodeEnvelope(signer.trusted.id, parsed.statementBytes, signature)
      const result = await verifySignatureFile(tampered, MODULE, keys, verifier)
      expect(result).toMatchObject({ ok: false, failure: 'bad-signature' })
    }
  })

  it('refuses a file that is not a signature file', async () => {
    const result = await verifySignatureFile(
      utf8('untrusted comment: minisign'),
      MODULE,
      keys,
      verifier,
    )
    expect(result).toMatchObject({ ok: false, failure: 'malformed' })
  })

  it('refuses a validly signed statement that is not a statement', async () => {
    const key = await importSigningKey((await generateSigningKey()).pkcs8)
    const statementBytes = utf8('{"kind":"youtube-module"}')
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, signedMessage(statementBytes)),
    )
    const result = await verifySignatureFile(
      encodeEnvelope(key.keyId, statementBytes, signature),
      MODULE,
      [{ id: key.keyId, publicKey: key.publicKey }],
      verifier,
    )
    expect(result).toMatchObject({ ok: false, failure: 'malformed' })
  })

  it.each([
    ['another kind', { kind: 'youtube-config' }],
    ['another file', { file: 'youtube-module-2.js' }],
    ['another contract', { api: 2 }],
    ['no contract', { api: undefined }],
  ])('refuses a signature for %s', async (_, change) => {
    const signed = await signedModule(change)
    const result = await verifySignatureFile(signed.envelope, MODULE, keys, verifier)
    expect(result).toMatchObject({ ok: false, failure: 'wrong-artifact' })
  })

  it('refuses an artifact larger than the build accepts for its kind', async () => {
    const signed = await signedModule({ bytes: new Uint8Array(1025) })
    const result = await verifySignatureFile(signed.envelope, MODULE, keys, verifier)
    expect(result).toMatchObject({ ok: false, failure: 'too-large' })
  })

  it('accepts nothing when the build trusts no key', async () => {
    const signed = await signedModule()
    const result = await verifySignatureFile(signed.envelope, MODULE, [], verifier)
    expect(result).toMatchObject({ ok: false, failure: 'unknown-key' })
  })
})

describe('checkArtifactBytes', () => {
  it('accepts the signed bytes and refuses any other', async () => {
    const { statement } = await signedModule()
    expect(checkArtifactBytes(BYTES, statement)).toBeUndefined()
    const changed = new Uint8Array(BYTES)
    changed[0] = 0x20
    expect(checkArtifactBytes(changed, statement)).toMatchObject({ failure: 'hash-mismatch' })
    expect(checkArtifactBytes(new Uint8Array([...BYTES, 0x20]), statement)).toMatchObject({
      failure: 'hash-mismatch',
    })
  })
})

describe('createSignatureVerifier', () => {
  const message = utf8('hello')
  let key: SigningKey
  let trusted: TrustedKey
  let signature: Uint8Array

  beforeAll(async () => {
    key = await importSigningKey((await generateSigningKey()).pkcs8)
    trusted = { id: key.keyId, publicKey: key.publicKey }
    signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, message),
    )
  })

  it('uses WebCrypto when it passes the known-answer test (Node 22 does)', async () => {
    expect(await createSignatureVerifier().engine()).toBe('webcrypto')
  })

  it('uses WebKit’s WebCrypto, which refuses only empty messages', async () => {
    const real = crypto.subtle
    const webkit = {
      importKey: real.importKey.bind(real),
      verify: (...args: Parameters<SubtleCrypto['verify']>) =>
        (args[3] as Uint8Array).length === 0 ? Promise.resolve(false) : real.verify(...args),
    } as unknown as SubtleCrypto
    const verifier = createSignatureVerifier({ subtle: webkit })
    expect(await verifier.engine()).toBe('webcrypto')
    expect(await verifier.verify(trusted, message, signature)).toBe(true)
  })

  it('uses the library without WebCrypto', async () => {
    const verifier = createSignatureVerifier({ subtle: null })
    expect(await verifier.engine()).toBe('noble')
    expect(await verifier.verify(trusted, message, signature)).toBe(true)
  })

  it('uses the library when WebCrypto has no Ed25519', async () => {
    const subtle = {
      importKey: () => Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError')),
    } as unknown as SubtleCrypto
    const verifier = createSignatureVerifier({ subtle })
    expect(await verifier.engine()).toBe('noble')
    expect(await verifier.verify(trusted, message, signature)).toBe(true)
    expect(await verifier.verify(trusted, utf8('other'), signature)).toBe(false)
  })

  it('does not trust a WebCrypto that accepts forgeries', async () => {
    const real = crypto.subtle
    const lying = {
      importKey: real.importKey.bind(real),
      verify: () => Promise.resolve(true),
    } as unknown as SubtleCrypto
    const verifier = createSignatureVerifier({ subtle: lying })
    expect(await verifier.engine()).toBe('noble')
    expect(await verifier.verify(trusted, utf8('forged'), signature)).toBe(false)
  })

  it('falls back to the library when WebCrypto fails unexpectedly', async () => {
    const real = crypto.subtle
    let calls = 0
    const flaky = {
      importKey: real.importKey.bind(real),
      verify: (...args: Parameters<SubtleCrypto['verify']>) => {
        calls += 1
        // The known-answer test makes two calls; then it breaks.
        return calls <= 2 ? real.verify(...args) : Promise.reject(new Error('OperationError'))
      },
    } as unknown as SubtleCrypto
    const verifier = createSignatureVerifier({ subtle: flaky })
    expect(await verifier.engine()).toBe('webcrypto')
    expect(await verifier.verify(trusted, message, signature)).toBe(true)
    expect(await verifier.verify(trusted, utf8('other'), signature)).toBe(false)
  })

  it('never throws for malformed input', async () => {
    for (const verifier of [createSignatureVerifier(), createSignatureVerifier({ subtle: null })]) {
      expect(await verifier.verify(trusted, message, new Uint8Array(63))).toBe(false)
      expect(
        await verifier.verify({ id: 'x', publicKey: new Uint8Array(31) }, message, signature),
      ).toBe(false)
      const notAPoint = { id: 'y', publicKey: new Uint8Array(32).fill(0xff) }
      expect(await verifier.verify(notAPoint, message, signature)).toBe(false)
    }
  })

  it('agrees with signatures made by the library', async () => {
    const { secretKey, publicKey } = ed25519.keygen()
    const statement = encodeStatement({
      kind: 'youtube-config',
      version: 4,
      file: 'youtube-config.json',
      size: 2,
      sha256: sha256Hex(utf8('{}')),
      signedAt: new Date(0).toISOString(),
    })
    const libSignature = ed25519.sign(signedMessage(statement), secretKey)
    const id = keyIdOf(publicKey)
    const envelope = encodeEnvelope(id, statement, libSignature)
    for (const [, makeVerifier] of ENGINES) {
      const result = await verifySignatureFile(
        envelope,
        { kind: 'youtube-config', file: 'youtube-config.json', maxBytes: 100 },
        [{ id, publicKey }],
        makeVerifier(),
      )
      expect(result.ok).toBe(true)
    }
    expect(toBase64(libSignature)).toHaveLength(88)
  })
})

describe('signUpdate', () => {
  it('refuses invalid input before signing', async () => {
    const key = await importSigningKey((await generateSigningKey()).pkcs8)
    await expect(
      signUpdate(key, { kind: 'youtube-config', version: 0, file: 'c.json', bytes: BYTES }),
    ).rejects.toThrow(/version/)
    await expect(
      signUpdate(key, { kind: 'youtube-config', version: 1, file: '../c.json', bytes: BYTES }),
    ).rejects.toThrow(/file/)
  })
})
