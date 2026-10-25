import { isFxmError } from '@fxm/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { keyIdOf } from './digest.ts'
import { fromHex, toBase64 } from './encoding.ts'
import {
  checkTrustedKeys,
  parseTrustedKeys,
  UPDATE_SIGNING_KEYS,
  UPDATE_SIGNING_READY,
} from './keys.ts'
import keyFile from './update-keys.json'
import { isValidPublicKey } from './verify.ts'

const publicKey = new Uint8Array(ed25519.keygen().publicKey)
const identity = new Uint8Array(ed25519.Point.ZERO.toBytes())

describe('what this build trusts', () => {
  it('is only the placeholder until the owner adds the real keys, so every build fails closed', () => {
    // When the owner commits the real public keys, this test changes with them: the placeholder
    // goes, and UPDATE_SIGNING_READY becomes true.
    expect(keyFile.keys).toEqual([
      expect.objectContaining({
        keyId: 'placeholder',
        publicKey: expect.stringContaining('PLACEHOLDER'),
      }),
    ])
    expect(UPDATE_SIGNING_KEYS).toEqual({
      keys: [],
      revoked: {},
      problems: ['placeholder is not an Ed25519 public key'],
    })
    expect(UPDATE_SIGNING_READY).toBe(false)
  })

  it('never holds a private key: each entry has only an ID and a public key', () => {
    for (const entry of keyFile.keys) {
      expect(Object.keys(entry).sort()).toEqual(['keyId', 'publicKey'])
      expect(entry.publicKey).not.toMatch(/-----BEGIN|PRIVATE/)
    }
  })
})

describe('parseTrustedKeys', () => {
  it('keeps a valid key listed under its own ID', () => {
    const keyId = keyIdOf(publicKey)
    expect(parseTrustedKeys({ keys: [{ keyId, publicKey: toBase64(publicKey) }] })).toEqual({
      keys: [{ keyId, publicKey }],
      revoked: {},
      problems: [],
    })
  })

  it('refuses a key under another ID, so a copy-paste slip is caught', () => {
    const result = parseTrustedKeys({
      keys: [{ keyId: 'ed25519-0000000000000000', publicKey: toBase64(publicKey) }],
    })
    expect(result.keys).toEqual([])
    expect(result.problems).toEqual([
      `ed25519-0000000000000000 should have the ID ${keyIdOf(publicKey)}`,
    ])
  })

  it('refuses keys that are not 32-byte points, and small-order points', () => {
    const smallOrder = fromHex('0100000000000000000000000000000000000000000000000000000000000000')
    const notCanonical = fromHex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')
    const candidates = [
      toBase64(new Uint8Array(31)),
      toBase64(smallOrder as Uint8Array),
      toBase64(notCanonical as Uint8Array),
      'not base64',
      42,
    ]
    const result = parseTrustedKeys({
      keys: candidates.map((key, index) => ({ keyId: `k${index}`, publicKey: key })),
    })
    expect(result.keys).toEqual([])
    expect(result.problems).toHaveLength(candidates.length)
  })

  it('refuses a key listed twice and a file without a key list', () => {
    const entry = { keyId: keyIdOf(publicKey), publicKey: toBase64(publicKey) }
    expect(parseTrustedKeys({ keys: [entry, entry] }).problems).toEqual([
      `${entry.keyId} is listed twice`,
    ])
    expect(parseTrustedKeys({}).keys).toEqual([])
    expect(parseTrustedKeys(null).problems).toEqual(['The key list has no "keys" array'])
    expect(parseTrustedKeys({ keys: [null] }).problems).toEqual([
      'entry 0 is not an Ed25519 public key',
    ])
  })

  it('reads the revoked versions per kind, and leaves out lists that are not versions', () => {
    const result = parseTrustedKeys({
      keys: [],
      revoked: { 'youtube-module': [4, 7], 'youtube-config': [0], Bad: [1], other: 'all' },
    })
    expect(result.revoked).toEqual({ 'youtube-module': [4, 7] })
    expect(result.problems).toEqual([
      'The revoked versions of youtube-config are not a list of versions',
      'The revoked versions of Bad are not a list of versions',
      'The revoked versions of other are not a list of versions',
    ])
    expect(parseTrustedKeys({ keys: [], revoked: [4] }).revoked).toEqual({})
  })
})

describe('checkTrustedKeys', () => {
  it('passes valid keys under their own IDs', () => {
    expect(() => checkTrustedKeys([{ keyId: keyIdOf(publicKey), publicKey }])).not.toThrow()
    expect(() => checkTrustedKeys([])).not.toThrow()
  })

  it.each([
    ['a small-order key', [{ keyId: keyIdOf(identity), publicKey: identity }]],
    ['a key under another ID', [{ keyId: 'ed25519-0000000000000000', publicKey }]],
    [
      'a key listed twice',
      [
        { keyId: keyIdOf(publicKey), publicKey },
        { keyId: keyIdOf(publicKey), publicKey },
      ],
    ],
  ])('refuses %s with Unsupported', (_, keys) => {
    let error: unknown
    try {
      checkTrustedKeys(keys)
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })
})

describe('isValidPublicKey', () => {
  it('accepts a generated key and refuses the identity and torsion points', () => {
    expect(isValidPublicKey(publicKey)).toBe(true)
    expect(isValidPublicKey(identity)).toBe(false)
    // A valid key plus a point of order 2 is a valid encoding, but not in the prime-order group.
    const order2 = ed25519.Point.fromBytes(
      fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f') as Uint8Array,
    )
    const mixed = ed25519.Point.fromBytes(publicKey).add(order2).toBytes()
    expect(isValidPublicKey(mixed)).toBe(false)
  })
})
