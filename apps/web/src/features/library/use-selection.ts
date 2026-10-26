import { useCallback, useMemo, useRef, useState } from 'react'

/** The selected items of a list, for moving or acting on several at once. */
export interface Selection {
  /** The selected keys that are still in the list. */
  selected: ReadonlySet<string>
  /**
   * Selects or deselects one key. With `extend` (Shift + click), selects every key between the
   * last one toggled and this one.
   */
  toggle: (key: string, extend?: boolean) => void
  selectAll: () => void
  clear: () => void
}

/** Multi-select over `keys`. Keys that leave the list leave the selection too. */
export function useSelection(keys: readonly string[]): Selection {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  // Read through a ref, so `toggle` keeps its identity and memoized rows don't re-render.
  const current = useRef(keys)
  current.current = keys

  const selected = useMemo(() => {
    const present = new Set(keys)
    const kept = [...chosen].filter((key) => present.has(key))
    return kept.length === chosen.size ? chosen : new Set(kept)
  }, [keys, chosen])

  const toggle = useCallback((key: string, extend = false) => {
    const order = current.current
    const from = anchor.current === null ? -1 : order.indexOf(anchor.current)
    const to = order.indexOf(key)
    setChosen((previous) => {
      const next = new Set(previous)
      if (extend && from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        for (const item of order.slice(start, end + 1)) next.add(item)
      } else if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
    anchor.current = key
  }, [])

  const selectAll = useCallback(() => setChosen(new Set(current.current)), [])
  const clear = useCallback(() => {
    anchor.current = null
    setChosen(new Set())
  }, [])

  return { selected, toggle, selectAll, clear }
}
