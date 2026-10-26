/**
 * Pure functions over saved orders: moving items (one or a selection) and reconciling a stored
 * order with what a list actually holds. Shuffle order uses `fisherYatesShuffle` from
 * `@fxm/core`, with an injectable random source.
 *
 * Orders are arrays of keys (track or playlist IDs). A playlist stores its whole order as one
 * array in its own record, so any change, from moving one song to shuffling 5,000, is a single
 * write of one record; see the README in this folder for why.
 *
 * @module
 */

/**
 * Where to move items:
 *
 * - `top` / `bottom`: to the start or the end, keeping their relative order
 * - `up` / `down`: one place, past the nearest item that is not moving
 * - `{ before: key }`: right before `key`, or to the end when `key` is `null` or not in the order
 *   (a drop target in a drag and drop)
 */
export type MoveTarget = 'top' | 'bottom' | 'up' | 'down' | { before: string | null }

/**
 * `order` with the items in `keys` moved to `target`. Moving items keep their relative order,
 * keys that are not in `order` are ignored, and the input is never changed.
 *
 * `up` and `down` move every selected item one place past its unselected neighbour, so a
 * scattered selection keeps its gaps and a block that already touches the edge stays put.
 */
export function moveKeys<K extends string>(
  order: readonly K[],
  keys: Iterable<string>,
  target: MoveTarget,
): K[] {
  const moving = new Set(keys)
  const result = [...order]
  if (moving.size === 0) return result
  if (target === 'up') {
    for (let index = 1; index < result.length; index++) {
      const item = result[index] as K
      const previous = result[index - 1] as K
      if (moving.has(item) && !moving.has(previous)) {
        result[index - 1] = item
        result[index] = previous
      }
    }
    return result
  }
  if (target === 'down') {
    for (let index = result.length - 2; index >= 0; index--) {
      const item = result[index] as K
      const next = result[index + 1] as K
      if (moving.has(item) && !moving.has(next)) {
        result[index + 1] = item
        result[index] = next
      }
    }
    return result
  }
  const selected = result.filter((key) => moving.has(key))
  const rest = result.filter((key) => !moving.has(key))
  if (target === 'top') return [...selected, ...rest]
  if (target === 'bottom') return [...rest, ...selected]
  // Drop before a key. When that key is itself moving, drop before the first item after it
  // that stays, so the block lands where the pointer was.
  const before = target.before
  let anchor = before === null ? -1 : result.indexOf(before as K)
  while (anchor >= 0 && moving.has(result[anchor] as K)) {
    anchor = anchor + 1 < result.length ? anchor + 1 : -1
  }
  if (anchor < 0) return [...rest, ...selected]
  const at = rest.indexOf(result[anchor] as K)
  return [...rest.slice(0, at), ...selected, ...rest.slice(at)]
}

/**
 * Lines a stored order up with the items a list holds now: keeps the stored order of every
 * item that is still there, drops the rest and duplicates (by `keyOf`), and puts items the
 * order lacks in front (`missing: 'first'`, how new likes and playlists arrive) or at the end.
 * Missing items keep the order they have in `present`.
 */
export function reconcileOrder<K extends string>(
  stored: readonly string[],
  present: readonly K[],
  { keyOf = (key: string) => key, missing = 'first' as 'first' | 'last' } = {},
): K[] {
  const byKey = new Map<string, K>()
  for (const item of present) {
    const key = keyOf(item)
    if (!byKey.has(key)) byKey.set(key, item)
  }
  const placed = new Set<string>()
  const kept: K[] = []
  for (const item of stored) {
    const key = keyOf(item)
    const current = byKey.get(key)
    if (current === undefined || placed.has(key)) continue
    placed.add(key)
    kept.push(current)
  }
  const added: K[] = []
  for (const [key, item] of byKey) {
    if (!placed.has(key)) added.push(item)
  }
  return missing === 'first' ? [...added, ...kept] : [...kept, ...added]
}

/** Whether two orders hold the same keys in the same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}
