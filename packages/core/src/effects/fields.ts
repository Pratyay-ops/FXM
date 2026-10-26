/**
 * Reading untrusted settings: only an object's own fields, never inherited ones such as
 * `toString`. Internal to the effects module.
 *
 * @module
 */

/** A reader of `value`'s own fields; every field of a value that isn't a plain object is absent. */
export function ownFields(value: unknown): (name: string) => unknown {
  const record: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return (name) => (Object.hasOwn(record, name) ? record[name] : undefined)
}
