import { describe, expect, it } from 'vitest'
import { fromBase64, fromHex, fromUtf8, toBase64, toHex, utf8 } from './encoding.ts'
import {
  encodeEnvelope,
  encodeStatement,
  MAX_SIGNATURE_BYTES,
  MAX_VERSION,
  parseEnvelope,
  parseStatement,
  SIGNATURE_CONTEXT,
  SIGNATURE_FORMAT,
  signedMessage,
  UpdateFormatError,
  type UpdateStatement,
} from './format.ts'

const STATEMENT: UpdateStatement = {
  kind: 'youtube-module',
  version: 3,
  api: 1,
  file: 'youtube-module-1.js',
  size: 1234,
  sha256: 'a'.repeat(64),
  signedAt: '2026-10-26T10:00:00.000Z',
}

const SIGNATURE = new Uint8Array(64).fill(7)

function envelope(fields: Record<string, unknown>): Uint8Array {
  return utf8(JSON.stringify(fields))
}

describe('encoding', () => {
  it('round-trips Base64, hex and UTF-8', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    expect(fromHex(toHex(bytes))).toEqual(bytes)
    expect(fromUtf8(utf8('Björk – Jóga'))).toBe('Björk – Jóga')
  })

  it('refuses anything but strict Base64, lower-case hex and valid UTF-8', () => {
    for (const text of ['AAA', 'AA=A', 'A A=', 'AA-_', 'AAAA\n'])
      expect(fromBase64(text)).toBeUndefined()
    for (const text of ['abc', 'AB', 'zz']) expect(fromHex(text)).toBeUndefined()
    expect(() => fromUtf8(new Uint8Array([0xff, 0xfe]))).toThrow(TypeError)
  })

  it('encodes large arrays to Base64 in chunks', () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })
})

describe('statements', () => {
  it('encodes a statement as compact JSON in a fixed field order', () => {
    const shuffled = { ...STATEMENT, signedAt: STATEMENT.signedAt, kind: STATEMENT.kind }
    const text = fromUtf8(encodeStatement(shuffled))
    expect(text).toBe(
      '{"kind":"youtube-module","version":3,"api":1,"file":"youtube-module-1.js","size":1234,' +
        `"sha256":"${'a'.repeat(64)}","signedAt":"2026-10-26T10:00:00.000Z"}`,
    )
    expect(parseStatement(utf8(text))).toEqual(STATEMENT)
  })

  it('records the source commit after the hash, and accepts versions up to 2^31 - 1', () => {
    const source = 'c'.repeat(40)
    const text = fromUtf8(encodeStatement({ ...STATEMENT, source, version: MAX_VERSION }))
    expect(text).toContain(`"sha256":"${'a'.repeat(64)}","source":"${source}","signedAt"`)
    expect(parseStatement(utf8(text))).toEqual({ ...STATEMENT, source, version: 2 ** 31 - 1 })
    expect(parseStatement(utf8(JSON.stringify({ ...STATEMENT, source: 'd'.repeat(64) })))).toEqual({
      ...STATEMENT,
      source: 'd'.repeat(64),
    })
  })

  it('leaves api out when there is none, and ignores unknown fields', () => {
    const { api: _api, ...data } = STATEMENT
    const parsed = parseStatement(utf8(JSON.stringify({ ...data, comment: 'newer field' })))
    expect(parsed).toEqual(data)
    expect('api' in parsed).toBe(false)
  })

  it.each([
    ['a version below 1', { version: 0 }],
    ['a fractional version', { version: 1.5 }],
    ['a version above 2^31 - 1', { version: 2 ** 31 }],
    ['a negative size', { size: -1 }],
    ['a size over 64 MiB', { size: 64 * 1024 * 1024 + 1 }],
    ['an upper-case hash', { sha256: 'A'.repeat(64) }],
    ['a short hash', { sha256: 'a'.repeat(63) }],
    ['a file with a path', { file: 'updates/youtube-module-1.js' }],
    ['a file with ..', { file: 'a..js' }],
    ['a file starting with a dot', { file: '.hidden' }],
    ['an upper-case kind', { kind: 'YouTube' }],
    ['an api of 0', { api: 0 }],
    ['a signedAt that is not a time', { signedAt: 'yesterday' }],
    ['a source that is not a commit', { source: 'main' }],
    ['a missing field', { kind: undefined }],
  ])('refuses %s', (_, change) => {
    const bytes = utf8(JSON.stringify({ ...STATEMENT, ...change }))
    expect(() => parseStatement(bytes)).toThrow(UpdateFormatError)
    expect(() => encodeStatement({ ...STATEMENT, ...change } as UpdateStatement)).toThrow(
      UpdateFormatError,
    )
  })

  it('refuses a statement that is not a JSON object, not UTF-8 or too long', () => {
    expect(() => parseStatement(utf8('[1,2]'))).toThrow(/not a JSON object/)
    expect(() => parseStatement(utf8('{'))).toThrow(/not JSON/)
    expect(() => parseStatement(new Uint8Array([0xc3, 0x28]))).toThrow(/not UTF-8/)
    expect(() => parseStatement(utf8(' '.repeat(2049)))).toThrow(/larger than 2048/)
  })

  it('signs the context, then the statement bytes', () => {
    const statement = encodeStatement(STATEMENT)
    expect(fromUtf8(signedMessage(statement))).toBe(`${SIGNATURE_CONTEXT}${fromUtf8(statement)}`)
  })
})

describe('signature files', () => {
  it('round-trips a signature file', () => {
    const statement = encodeStatement(STATEMENT)
    const parsed = parseEnvelope(encodeEnvelope('ed25519-0123456789abcdef', statement, SIGNATURE))
    expect(parsed.keyId).toBe('ed25519-0123456789abcdef')
    expect(parsed.statementBytes).toEqual(statement)
    expect(parsed.signature).toEqual(SIGNATURE)
  })

  it('writes readable JSON with the format name', () => {
    const text = fromUtf8(encodeEnvelope('ed25519-0123456789abcdef', utf8('{}'), SIGNATURE))
    expect(JSON.parse(text)).toMatchObject({ format: SIGNATURE_FORMAT })
    expect(text.endsWith('}\n')).toBe(true)
  })

  const valid = {
    format: SIGNATURE_FORMAT,
    keyId: 'ed25519-0123456789abcdef',
    statement: toBase64(encodeStatement(STATEMENT)),
    signature: toBase64(SIGNATURE),
  }

  it.each([
    ['another format', { format: 'minisign' }],
    ['a key ID with spaces', { keyId: 'my key' }],
    ['a statement that is not Base64', { statement: 'not base64!' }],
    ['a statement over 2048 bytes', { statement: toBase64(new Uint8Array(2049)) }],
    ['a 63-byte signature', { signature: toBase64(new Uint8Array(63)) }],
    ['a signature that is not a string', { signature: 42 }],
  ])('refuses %s', (_, change) => {
    expect(() => parseEnvelope(envelope({ ...valid, ...change }))).toThrow(UpdateFormatError)
  })

  it('refuses a file that is not JSON, not an object or too large', () => {
    expect(() => parseEnvelope(utf8('minisign'))).toThrow(/not JSON/)
    expect(() => parseEnvelope(utf8('null'))).toThrow(/not a JSON object/)
    expect(() => parseEnvelope(new Uint8Array(MAX_SIGNATURE_BYTES + 1))).toThrow(/larger/)
  })

  it('refuses to write an invalid key ID', () => {
    expect(() => encodeEnvelope('Bad Key', utf8('{}'), SIGNATURE)).toThrow(UpdateFormatError)
  })
})
