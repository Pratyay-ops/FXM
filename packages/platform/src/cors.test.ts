import { describe, expect, it } from 'vitest'
import {
  corsUnsafeRequestHeaderNames,
  isCorsSafelistedRequestHeader,
  isCorsSimpleRequest,
} from './cors'

describe('isCorsSafelistedRequestHeader', () => {
  it.each([
    ['Accept', '*/*'],
    ['accept', 'application/json, text/plain;q=0.9'],
    ['accept', 'tab\tis allowed'],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['content-language', 'hi'],
    ['Content-Type', 'text/plain;charset=UTF-8'],
    ['content-type', 'TEXT/PLAIN'],
    ['content-type', 'application/x-www-form-urlencoded'],
    ['content-type', 'multipart/form-data; boundary=x'],
    ['range', 'bytes=0-'],
    ['range', 'bytes=1048576-1114111'],
    ['range', 'bytes=5-5'],
  ])('safelists %s: %s', (name, value) => {
    expect(isCorsSafelistedRequestHeader(name, value)).toBe(true)
  })

  it.each([
    ['content-type', 'application/json'],
    ['content-type', 'application/x-protobuf'],
    ['content-type', 'text/plain, application/json'],
    ['content-type', 'text/plain; x="a"'],
    ['accept', 'a(b)'],
    ['accept', 'line\nbreak'],
    ['accept', 'del\u007f'],
    ['accept-language', 'en_US'],
    ['content-language', 'en/us'],
    ['range', 'bytes=-500'],
    ['range', 'bytes=500-100'],
    ['range', 'bytes=0-1,5-6'],
    ['range', 'items=0-1'],
    ['accept', 'a'.repeat(129)],
    ['authorization', 'Bearer x'],
    ['x-goog-visitor-id', 'Cgt4'],
    ['x-youtube-client-name', '67'],
    ['x-youtube-client-version', '1.20261020.01.00'],
    ['user-agent', 'Mozilla/5.0'],
    ['origin', 'https://www.youtube.com'],
    ['cookie', 'a=b'],
  ])('does not safelist %s: %s', (name, value) => {
    expect(isCorsSafelistedRequestHeader(name, value)).toBe(false)
  })
})

describe('corsUnsafeRequestHeaderNames', () => {
  it('lists the headers that cause a preflight, in lower case', () => {
    expect(
      corsUnsafeRequestHeaderNames(
        new Headers({
          Accept: '*/*',
          'Content-Type': 'application/json',
          'X-Goog-Visitor-Id': 'Cgt4',
        }),
      ).sort(),
    ).toEqual(['content-type', 'x-goog-visitor-id'])
    expect(corsUnsafeRequestHeaderNames([])).toEqual([])
  })

  it('counts every safelisted header as unsafe once their values pass 1024 bytes', () => {
    const many = Array.from({ length: 9 }, () => ['accept', 'a'.repeat(120)] as const)
    expect(corsUnsafeRequestHeaderNames(many)).toHaveLength(9)
    expect(corsUnsafeRequestHeaderNames(many.slice(0, 8))).toEqual([])
  })
})

describe('isCorsSimpleRequest', () => {
  it('accepts GET, HEAD and POST with safelisted headers only', () => {
    expect(isCorsSimpleRequest('POST', [['content-type', 'text/plain;charset=UTF-8']])).toBe(true)
    expect(isCorsSimpleRequest('get', [])).toBe(true)
    expect(isCorsSimpleRequest('HEAD', [['range', 'bytes=0-']])).toBe(true)
    expect(isCorsSimpleRequest('PUT', [])).toBe(false)
    expect(isCorsSimpleRequest('POST', [['content-type', 'application/json']])).toBe(false)
  })
})
