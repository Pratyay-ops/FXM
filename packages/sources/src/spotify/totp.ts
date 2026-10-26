/**
 * One-time passwords: HOTP (RFC 4226) and TOTP (RFC 6238) with HMAC-SHA1, computed with
 * WebCrypto (`crypto.subtle`), which every FXM platform has: browsers and webviews in a secure
 * context, web workers and Node. No dependency.
 *
 * @module
 */

/** Options for {@link totp}. */
export interface TotpOptions {
  /** The time step in seconds. Default 30. */
  periodSeconds?: number
  /** The number of digits, 6 to 8. Default 6. */
  digits?: number
}

const TWO_POW_32 = 0x1_0000_0000

function checkDigits(digits: number): void {
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError('A one-time password has 6 to 8 digits')
  }
}

/**
 * The HOTP value (RFC 4226) of `key` for `counter`: HMAC-SHA1 over the counter as 8 big-endian
 * bytes, dynamically truncated to 31 bits and reduced to `digits` decimal digits, zero-padded.
 *
 * @param key The shared secret, as raw bytes.
 * @param counter A non-negative safe integer.
 * @param digits 6 to 8.
 */
export async function hotp(
  key: Uint8Array<ArrayBuffer>,
  counter: number,
  digits = 6,
): Promise<string> {
  checkDigits(digits)
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('The HOTP counter must be a non-negative safe integer')
  }
  const message = new Uint8Array(8)
  const view = new DataView(message.buffer)
  view.setUint32(0, Math.floor(counter / TWO_POW_32))
  view.setUint32(4, counter % TWO_POW_32)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message))
  const offset = (mac[19] ?? 0) & 0x0f
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * The TOTP value (RFC 6238) of `key` at `timeMs`: the HOTP of the number of whole time steps
 * since the Unix epoch.
 *
 * @param key The shared secret, as raw bytes.
 * @param timeMs The time, as epoch milliseconds (not negative).
 */
export async function totp(
  key: Uint8Array<ArrayBuffer>,
  timeMs: number,
  options: TotpOptions = {},
): Promise<string> {
  const { periodSeconds = 30, digits = 6 } = options
  if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) {
    throw new RangeError('The TOTP period must be a positive number of seconds')
  }
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new RangeError('The TOTP time must be a non-negative number of milliseconds')
  }
  return hotp(key, Math.floor(timeMs / 1000 / periodSeconds), digits)
}
