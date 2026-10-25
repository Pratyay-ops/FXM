/**
 * Reading InnerTube's JSON without trusting its shape. YouTube changes its responses often, so
 * every read is a lookup that may come back empty rather than a cast that may crash.
 *
 * @module
 */

/** A JSON object read from a response. */
export type JsonRecord = Readonly<Record<string, unknown>>

/** `value` when it is a plain object, else `undefined`. */
export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

/** `value` when it is an array, else an empty one. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** `value` when it is a string, else `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `value` when it is a finite number, else `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Follows `path` through objects (string keys, own properties only) and arrays (numeric
 * indexes), and returns what is there, or `undefined` as soon as a step is missing.
 */
export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current = value
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[step]
    } else {
      const object = asRecord(current)
      if (object === undefined || !Object.hasOwn(object, step)) return undefined
      current = object[step]
    }
  }
  return current
}

/** The string at `path`, if there is one. */
export function stringAt(
  value: unknown,
  ...path: readonly (string | number)[]
): string | undefined {
  return asString(at(value, ...path))
}

/** The object at `path`, if there is one. */
export function recordAt(
  value: unknown,
  ...path: readonly (string | number)[]
): JsonRecord | undefined {
  return asRecord(at(value, ...path))
}

/** The array at `path`, or an empty one. */
export function arrayAt(value: unknown, ...path: readonly (string | number)[]): readonly unknown[] {
  return asArray(at(value, ...path))
}

/**
 * The renderer inside a wrapper such as `{ musicShelfRenderer: {…} }`: the name and content of
 * its first key that ends in `Renderer` or `ViewModel` and holds an object, or `undefined`.
 */
export function unwrap(value: unknown): { name: string; renderer: JsonRecord } | undefined {
  const object = asRecord(value)
  if (object === undefined) return undefined
  for (const [name, content] of Object.entries(object)) {
    const renderer = asRecord(content)
    if (renderer !== undefined && (name.endsWith('Renderer') || name.endsWith('ViewModel'))) {
      return { name, renderer }
    }
  }
  return undefined
}
