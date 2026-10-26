import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

/** What should get focus once some rows have left a list. */
interface PendingFocus {
  gone: ReadonlySet<string>
  target: () => HTMLElement | null | undefined
}

/**
 * The row that takes the place of the first of `gone` once they leave `ids`: the next row that
 * stays, else the one before them. `undefined` when no row stays.
 */
export function neighborAfterRemoval(
  ids: readonly string[],
  gone: ReadonlySet<string>,
): string | undefined {
  const first = ids.findIndex((id) => gone.has(id))
  if (first < 0) return undefined
  return ids.slice(first + 1).find((id) => !gone.has(id)) ?? ids[first - 1]
}

/**
 * Keeps keyboard focus in a list whose rows go away. A row that leaves (removed from a
 * playlist, unliked from Liked songs, unfollowed) takes its focused control with it, and focus
 * would fall back to the start of the page. Call `expect(gone, target)` before the removal: once
 * none of `gone` is in `ids`, `target()` gets focus, if focus was lost meanwhile. `cancel()`
 * forgets it, e.g. when the removal failed or removed nothing.
 */
export function useFocusAfterRemoval(ids: readonly string[]) {
  const pending = useRef<PendingFocus | null>(null)

  useLayoutEffect(() => {
    const want = pending.current
    if (want === null || ids.some((id) => want.gone.has(id))) return
    pending.current = null
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected) return
    want.target()?.focus()
  }, [ids])

  const expect = useCallback(
    (gone: Iterable<string>, target: () => HTMLElement | null | undefined) => {
      pending.current = { gone: new Set(gone), target }
    },
    [],
  )
  const cancel = useCallback(() => {
    pending.current = null
  }, [])
  // One object for the component's life, so callbacks that use it keep their identity too.
  return useMemo(() => ({ expect, cancel }), [expect, cancel])
}

/** The control `selector` matches in the row of `list` whose `data-row` is `id`. */
export function rowControl(
  list: HTMLElement | null,
  id: string | undefined,
  selector: string,
): HTMLElement | null {
  if (list === null || id === undefined) return null
  for (const row of list.querySelectorAll<HTMLElement>('[data-row]')) {
    if (row.dataset.row === id) return row.querySelector<HTMLElement>(selector)
  }
  return null
}
