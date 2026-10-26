/**
 * Numbers that callers pass in, such as limits and allowances, read defensively: a value that
 * is not a finite number never turns a limit off.
 *
 * @module
 */

/**
 * `value` rounded down and kept from `min` to `max`, or `fallback` when it is not a finite
 * number (`NaN`, `Infinity`, a string...).
 */
export function wholeNumber(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
