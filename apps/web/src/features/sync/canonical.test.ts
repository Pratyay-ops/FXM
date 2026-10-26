import { describe, expect, it } from 'vitest'
import { canonicalJson, hash53, hashHex, sameJson, utf8Length } from './canonical'

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' } })).toBe(
      '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}',
    )
  })

  it('leaves out undefined fields as JSON.stringify does', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined] })).toBe('{"b":null,"c":[null]}')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('gives equal text for equal data whatever the field order', () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameJson(undefined, null)).toBe(true)
  })

  it('reads back to the same text', () => {
    const value = { z: [1.5, -0, 1e21, 'line\nbreak', ' ', { '': true }], a: 'ü😀' }
    const text = canonicalJson(value)
    expect(canonicalJson(JSON.parse(text))).toBe(text)
  })
})

describe('hashes', () => {
  it('are stable, spread and 14 hex digits long', () => {
    expect(hash53('fxm')).toBe(hash53('fxm'))
    expect(hash53('fxm')).not.toBe(hash53('fxn'))
    expect(Number.isSafeInteger(hash53('anything'))).toBe(true)
    expect(hashHex('fxm')).toMatch(/^[0-9a-f]{14}$/)
    expect(hashHex('')).toMatch(/^[0-9a-f]{14}$/)
  })
})

describe('utf8Length', () => {
  it('counts UTF-8 bytes like TextEncoder', () => {
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\ud800', 'x\udc00y']) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length)
    }
  })
})
