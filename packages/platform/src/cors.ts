/**
 * Which requests a browser sends without a CORS preflight, following the Fetch standard's
 * "CORS-safelisted request-header" rules. InnerTube refuses preflights from the Lite tier's
 * opaque origin, so every InnerTube request must pass {@link isCorsSimpleRequest}; the sandbox
 * (stage 1.10) can check the same way.
 *
 * @module
 */

/** Methods that never cause a preflight. */
export const CORS_SAFELISTED_METHODS = ['GET', 'HEAD', 'POST'] as const

/** `Content-Type` essences that never cause a preflight. */
const SAFELISTED_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]

/** The printable "CORS-unsafe request-header bytes". */
const UNSAFE_PRINTABLE = '"():<>?@[\\]{}'

/**
 * Whether a value holds a "CORS-unsafe request-header byte": a control character other than
 * tab, DEL, or one of `"():<>?@[\]{}`.
 */
function hasUnsafeByte(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || UNSAFE_PRINTABLE.includes(char)) {
      return true
    }
  }
  return false
}

/** The bytes `Accept-Language` and `Content-Language` may hold. */
const LANGUAGE_VALUE = /^[0-9A-Za-z *,\-.;=]*$/

/** A single range with a start, such as `bytes=0-` or `bytes=0-499` (suffix ranges are not). */
const SIMPLE_RANGE = /^bytes=(\d+)-(\d*)$/

/** Longest value a safelisted header may have, in bytes. */
const MAX_VALUE_LENGTH = 128

/** Most bytes all safelisted header values together may have. */
const MAX_TOTAL_LENGTH = 1024

/**
 * Whether a header is CORS-safelisted, so that sending it never causes a preflight: `Accept`,
 * `Accept-Language`, `Content-Language`, `Content-Type` with a form or `text/plain` essence,
 * and a single `Range` with a start, each with a value of at most 128 bytes and only the bytes
 * the standard allows. Every other header, including `Authorization`, `User-Agent` and every
 * `X-…` header, causes one.
 */
export function isCorsSafelistedRequestHeader(name: string, value: string): boolean {
  if (value.length > MAX_VALUE_LENGTH) return false
  switch (name.toLowerCase()) {
    case 'accept':
      return !hasUnsafeByte(value)
    case 'accept-language':
    case 'content-language':
      return LANGUAGE_VALUE.test(value)
    case 'content-type': {
      if (hasUnsafeByte(value)) return false
      const essence = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      return SAFELISTED_CONTENT_TYPES.includes(essence)
    }
    case 'range': {
      const match = SIMPLE_RANGE.exec(value)
      if (match === null) return false
      const end = match[2] ?? ''
      return end === '' || Number(match[1]) <= Number(end)
    }
    default:
      return false
  }
}

/**
 * The names (lower case) of the headers that would make a browser send a preflight: every
 * header that is not CORS-safelisted, and all of them once the safelisted values add up to more
 * than 1024 bytes. Empty for a request that needs no preflight because of its headers.
 */
export function corsUnsafeRequestHeaderNames(
  headers: Iterable<readonly [string, string]>,
): string[] {
  const unsafe: string[] = []
  const safelisted: string[] = []
  let total = 0
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase()
    if (isCorsSafelistedRequestHeader(name, value)) {
      safelisted.push(name)
      total += value.length
    } else {
      unsafe.push(name)
    }
  }
  return total > MAX_TOTAL_LENGTH ? [...unsafe, ...safelisted] : unsafe
}

/**
 * Whether a browser sends a request with this method and these headers without a preflight. A
 * `ReadableStream` body also causes one, which callers check separately.
 */
export function isCorsSimpleRequest(
  method: string,
  headers: Iterable<readonly [string, string]>,
): boolean {
  return (
    (CORS_SAFELISTED_METHODS as readonly string[]).includes(method.toUpperCase()) &&
    corsUnsafeRequestHeaderNames(headers).length === 0
  )
}
