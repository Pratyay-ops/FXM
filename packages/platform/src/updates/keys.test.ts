import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { keyIdOf } from './digest.ts'
import { fromHex, toBase64 } from './encoding.ts'
import {
  isValidPublicKey,
  parseTrustedKeys,
  UPDATE_SIGNING_KEYS,
  UPDATE_SIGNING_READY,
} from './keys.ts'
import keyFile from './update-keys.json'

const { publicKey } = ed25519.keygen()

describe('the keys compiled into this build', () => {
  it('are only the placeholder until the owner adds the real key, so every build fails closed', () => {
    // When the owner commits the real public key, this test changes with it: the placeholder
    // goes, and UPDATE_SIGNING_READY becomes true.
    expect(keyFile.keys).toEqual([
      expect.objectContaining({
        id: 'placeholder',
        publicKey: expect.stringContaining('PLACEHOLDER'),
      }),
    ])
    expect(UPDATE_SIGNING_KEYS.keys).toEqual([])
    expect(UPDATE_SIGNING_KEYS.problems).toEqual(['placeholder is not an Ed25519 public key'])
    expect(UPDATE_SIGNING_READY).toBe(false)
  })

  it('never hold a private key: each entry has only an ID and a public key', () => {
    for (const entry of keyFile.keys) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'publicKey'])
      expect(entry.publicKey).not.toMatch(/-----BEGIN|PRIVATE/)
    }
  })
})

describe('parseTrustedKeys', () => {
  it('keeps a valid key listed under its own ID', () => {
    const id = keyIdOf(publicKey)
    expect(parseTrustedKeys({ keys: [{ id, publicKey: toBase64(publicKey) }] })).toEqual({
      keys: [{ id, publicKey }],
      problems: [],
    })
  })

  it('refuses a key under another ID, so a copy-paste slip is caught', () => {
    const result = parseTrustedKeys({
      keys: [{ id: 'ed25519-0000000000000000', publicKey: toBase64(publicKey) }],
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
      keys: candidates.map((key, index) => ({ id: `k${index}`, publicKey: key })),
    })
    expect(result.keys).toEqual([])
    expect(result.problems).toHaveLength(candidates.length)
  })

  it('refuses a key listed twice and a file without a key list', () => {
    const entry = { id: keyIdOf(publicKey), publicKey: toBase64(publicKey) }
    expect(parseTrustedKeys({ keys: [entry, entry] }).problems).toEqual([
      `${entry.id} is listed twice`,
    ])
    expect(parseTrustedKeys({}).keys).toEqual([])
    expect(parseTrustedKeys(null).problems).toEqual(['The key list has no "keys" array'])
    expect(parseTrustedKeys({ keys: [null] }).problems).toEqual([
      'entry 0 is not an Ed25519 public key',
    ])
  })
})

describe('isValidPublicKey', () => {
  it('accepts a generated key and refuses the identity and torsion points', () => {
    expect(isValidPublicKey(publicKey)).toBe(true)
    const identity = ed25519.Point.ZERO.toBytes()
    expect(isValidPublicKey(identity)).toBe(false)
    // A valid key plus a point of order 2 is a valid encoding, but not in the prime-order group.
    const order2 = ed25519.Point.fromBytes(
      fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f') as Uint8Array,
    )
    const mixed = ed25519.Point.fromBytes(publicKey).add(order2).toBytes()
    expect(isValidPublicKey(mixed)).toBe(false)
  })
})
