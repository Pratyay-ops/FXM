import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  decodePublicKey,
  decodeSecretKey,
  encodePublicKey,
  generateKeyPair,
  keyIdHex,
  type SecretKey,
  samePublicKey,
  scryptParams,
  sign,
  signedVersion,
  strictBase64,
  trustedComment,
  verify,
} from './minisign.ts'
import { cliKeyPair, cliSign, temporaryFolder } from './testing.ts'

// The Tauri CLI's scrypt and the key pairs take a moment, more on a busy machine.
const SLOW = 60_000

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/updater/${name}`, import.meta.url))

/** The text inside a base64-encoded key or signature. */
const text = (base64: string) => Buffer.from(base64, 'base64').toString('utf8')

describe('keys made by the Tauri CLI', () => {
  let folder: string
  let cli: ReturnType<typeof cliKeyPair>
  let empty: ReturnType<typeof cliKeyPair>

  beforeAll(() => {
    folder = temporaryFolder('minisign')
    cli = cliKeyPair(folder, 'fxm test password')
    empty = cliKeyPair(join(folder, 'empty'), '')
  }, SLOW)
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  it('decrypt with their password, to the key their public key names', () => {
    const secret = decodeSecretKey(cli.secretKey, 'fxm test password')
    const publicKey = decodePublicKey(cli.publicKey)
    expect(samePublicKey(secret, publicKey)).toBe(true)
    expect(text(cli.publicKey)).toContain(`minisign public key: ${keyIdHex(publicKey.keyId)}`)
  })

  it('decrypt with an empty password when they have none (tauri signer generate --ci)', () => {
    const secret = decodeSecretKey(empty.secretKey, '')
    expect(samePublicKey(secret, decodePublicKey(empty.publicKey))).toBe(true)
  })

  it('refuse a wrong password, as the CLI does', () => {
    expect(() => decodeSecretKey(cli.secretKey, 'wrong')).toThrow(/Wrong password/)
    expect(() => decodeSecretKey(empty.secretKey, 'not empty')).toThrow(/Wrong password/)
  })

  it(
    'sign files the way the CLI does: the CLI’s signatures and ours check out alike',
    () => {
      const file = join(folder, 'FXM.app.tar.gz')
      writeFileSync(file, 'an update')
      const data = readFileSync(file)
      const publicKey = decodePublicKey(cli.publicKey)
      const theirs = cliSign(cli.path, 'fxm test password', file, '1.2.3')
      const secret = decodeSecretKey(cli.secretKey, 'fxm test password')
      const ours = sign(data, secret, trustedComment('FXM.app.tar.gz', '1.2.3', 1793000000))
      const theirComment = verify(data, theirs, publicKey)
      expect(theirComment).toMatch(/^timestamp:\d+\tfile:FXM\.app\.tar\.gz\tversion:1\.2\.3$/)
      expect(verify(data, ours, publicKey)).toBe(
        'timestamp:1793000000\tfile:FXM.app.tar.gz\tversion:1.2.3',
      )
      // The same shape, line for line: comments, algorithm, key id.
      const lines = (signature: string) => text(signature).split('\n')
      expect(lines(ours)[0]).toBe(lines(theirs)[0])
      expect(Buffer.from(lines(ours)[1] ?? '', 'base64').subarray(0, 10)).toEqual(
        Buffer.from(lines(theirs)[1] ?? '', 'base64').subarray(0, 10),
      )
    },
    SLOW,
  )

  it(
    'accept the keys this module makes: the CLI signs with them, also without a password',
    () => {
      // The empty password is the build jobs' throwaway key (release.ts build-key).
      for (const password of ['made here', '']) {
        const pair = generateKeyPair(password)
        const keyPath = join(folder, `made-here-${password.length}.key`)
        writeFileSync(keyPath, pair.secretKey)
        const file = join(folder, 'data.bin')
        writeFileSync(file, 'signed by the CLI with our key')
        const signature = cliSign(keyPath, password, file, '0.7.0')
        const comment = verify(readFileSync(file), signature, decodePublicKey(pair.publicKey))
        expect(signedVersion(comment)).toBe('0.7.0')
      }
    },
    SLOW,
  )
})

describe('the fixture shared with the Rust test (test/fixtures/updater)', () => {
  it('checks out: our signature of data.txt, for version 1.2.3', () => {
    const publicKey = decodePublicKey(fixture('test-key.pub').toString('utf8'))
    const comment = verify(fixture('data.txt'), fixture('data.txt.sig').toString('utf8'), publicKey)
    expect(comment).toBe('timestamp:1793000000\tfile:data.txt\tversion:1.2.3')
  })
})

describe('signatures', () => {
  const password = 'p'
  let secret: SecretKey
  let publicKey: ReturnType<typeof decodePublicKey>
  let other: ReturnType<typeof decodePublicKey>
  const data = Buffer.from('FXM 0.7.0')

  beforeAll(() => {
    const pair = generateKeyPair(password)
    secret = decodeSecretKey(pair.secretKey, password)
    publicKey = decodePublicKey(pair.publicKey)
    other = decodePublicKey(generateKeyPair(password).publicKey)
  }, SLOW)

  it('cover the file: any other bytes fail', () => {
    const signature = sign(data, secret, trustedComment('x', '0.7.0', 1))
    expect(() => verify(Buffer.from('FXM 0.7.1'), signature, publicKey)).toThrow(
      /does not match the file/,
    )
  })

  it('cover the trusted comment, so the version can’t be changed', () => {
    const signature = sign(data, secret, trustedComment('x', '0.7.0', 1))
    const forged = Buffer.from(text(signature).replace('version:0.7.0', 'version:9.9.9')).toString(
      'base64',
    )
    expect(() => verify(data, forged, publicKey)).toThrow(/trusted comment/)
  })

  it('name their key: a signature by another key fails', () => {
    const signature = sign(data, secret, trustedComment('x', '0.7.0', 1))
    expect(() => verify(data, signature, other)).toThrow(/another key/)
  })

  it('carry the version the updater reads', () => {
    const comment = verify(data, sign(data, secret, trustedComment('a.exe', '0.7.0', 5)), publicKey)
    expect(signedVersion(comment)).toBe('0.7.0')
    expect(signedVersion('timestamp:1\tfile:app-version:2.zip')).toBeUndefined()
  })

  it('refuse a trusted comment that breaks the format', () => {
    expect(() => trustedComment('a\tfile:b', '0.7.0', 1)).toThrow(/tab or a newline/)
    expect(() => trustedComment('a', '0.7.0\n', 1)).toThrow(/tab or a newline/)
    expect(() => sign(data, secret, 'two\nlines')).toThrow(/one line/)
  })

  it('refuse damaged text', () => {
    expect(() => verify(data, 'not base64!', publicKey)).toThrow(/not base64/)
    expect(() => verify(data, Buffer.from('one line').toString('base64'), publicKey)).toThrow()
  })
})

describe('keys', () => {
  it(
    'round-trip: a generated pair decodes to the same key',
    () => {
      const pair = generateKeyPair('round trip')
      const secret = decodeSecretKey(pair.secretKey, 'round trip')
      const publicKey = decodePublicKey(pair.publicKey)
      expect(samePublicKey(secret, publicKey)).toBe(true)
      expect(decodePublicKey(encodePublicKey(publicKey))).toEqual(publicKey)
    },
    SLOW,
  )

  it('refuse the placeholder and anything else that isn’t a public key', () => {
    const placeholder = 'PLACEHOLDER: this build has no updater key yet.'
    for (const value of [
      placeholder,
      '',
      'aGVsbG8=',
      Buffer.from('untrusted comment: x\nAAAA\n').toString('base64'),
    ]) {
      expect(() => decodePublicKey(value), value).toThrow()
    }
  })

  it(
    'refuse an unencrypted secret key, as the CLI does',
    () => {
      const pair = generateKeyPair('x')
      const [comment, encoded] = text(pair.secretKey).split('\n')
      const bytes = Buffer.from(encoded ?? '', 'base64')
      bytes[2] = 0
      bytes[3] = 0
      const unencrypted = Buffer.from(`${comment}\n${bytes.toString('base64')}\n`).toString(
        'base64',
      )
      expect(() => decodeSecretKey(unencrypted, 'x')).toThrow(/not encrypted/)
    },
    SLOW,
  )

  it('name their id as minisign prints it, a little-endian number in hex', () => {
    expect(keyIdHex(Buffer.from('0102030405060708', 'hex'))).toBe('0807060504030201')
  })

  it('read base64 strictly, where Node’s decoder would skip stray characters', () => {
    expect(strictBase64(' aGVsbG8= ', 'x').toString()).toBe('hello')
    for (const value of ['aGVsbG8', 'aGVs bG8=', 'aGVsbG8=!']) {
      expect(() => strictBase64(value, 'x'), value).toThrow(/not base64/)
    }
  })

  it('pick minisign’s scrypt costs for its default limits: N 2^15, r 8, p 1', () => {
    expect(scryptParams(1_048_576, 33_554_432)).toEqual({ nLog2: 15, r: 8, p: 1 })
    expect(() => scryptParams(1_048_576, 2 ** 31)).toThrow(/too much memory/)
  })
})
