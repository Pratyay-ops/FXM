import { type RefObject, useEffect, useRef, useState } from 'react'
import { buttonClasses } from '../../../components/ui/button'

/** The first element in `root` that the Tab key can reach, skipping hidden ones. */
export function firstFocusable(root: Element): HTMLElement | undefined {
  for (const element of root.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]')) {
    if (element.tabIndex < 0 || element.matches(':disabled')) continue
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) continue
    return element
  }
  return undefined
}

/** What the last "Show more" brought, for a status message. */
export interface LoadedMore {
  /** How many rows it added. */
  readonly added: number
  /** How many rows there are now. */
  readonly total: number
}

/** Whether focus is still on a "Show more" button, or was lost (to the page) with it. */
function focusStayedWithButton(): boolean {
  const active = document.activeElement
  return (
    active === null ||
    active === document.body ||
    (active instanceof HTMLElement && active.dataset.showMore !== undefined)
  )
}

/**
 * "Show more" under a list that loads a page at a time, made for keyboard and screen reader
 * users as much as for anyone:
 *
 * - while the page loads, the button keeps focus and ignores clicks ({@link ShowMoreButton} is
 *   `aria-disabled`: a `disabled` button would drop focus to the start of the page);
 * - once the page is there, focus moves to the first new row, where reading goes on (with the
 *   last page, the button itself goes);
 * - if the page fails, focus moves to the error's "Try again";
 * - `loaded` tells how many rows arrived, for a polite status message.
 *
 * Focus moves only while it is still on the button or was lost with it, never away from
 * something the user went to meanwhile. `count` is the number of rows shown, and `list` holds
 * them: the rows are the items of the first `<ul>` in it. `loaded` is forgotten when `listKey`
 * changes (a new query, say).
 */
export function useShowMore({
  count,
  isFetching,
  failed,
  fetchNextPage,
  list,
  listKey,
}: {
  count: number
  isFetching: boolean
  failed: boolean
  fetchNextPage: () => unknown
  list: RefObject<HTMLElement | null>
  listKey: string
}): { showMore: () => void; loaded: LoadedMore | undefined } {
  // The row count when "Show more" was pressed, and whether the fetch has been seen to start.
  const pending = useRef<{ from: number; started: boolean } | null>(null)
  const [loaded, setLoaded] = useState<LoadedMore & { readonly listKey: string }>()

  useEffect(() => {
    const request = pending.current
    if (request === null) return
    if (isFetching) {
      request.started = true
      return
    }
    if (!request.started) return
    pending.current = null
    const root = list.current
    if (failed) {
      if (focusStayedWithButton()) {
        root?.querySelector<HTMLElement>('[role="alert"] button, [role="alert"]')?.focus()
      }
      return
    }
    setLoaded({ added: count - request.from, total: count, listKey })
    const row = root?.querySelector('ul')?.children[request.from]
    const target = row ? firstFocusable(row) : undefined
    if (target && focusStayedWithButton()) target.focus()
  }, [count, isFetching, failed, list, listKey])

  const showMore = () => {
    if (isFetching) return
    pending.current = { from: count, started: false }
    setLoaded(undefined)
    void fetchNextPage()
  }
  return { showMore, loaded: loaded?.listKey === listKey ? loaded : undefined }
}

/** The "Show more" button of {@link useShowMore}, centered under its list. */
export function ShowMoreButton({
  loading,
  onClick,
  children,
}: {
  /** The next page is loading: the button says so and ignores clicks, but keeps focus. */
  loading: boolean
  onClick: () => void
  /** The label, e.g. "Show more songs". */
  children: string
}) {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        data-show-more=""
        aria-disabled={loading || undefined}
        onClick={onClick}
        className={buttonClasses({
          variant: 'secondary',
          className: 'aria-disabled:cursor-progress aria-disabled:opacity-70',
        })}
      >
        {loading ? 'Loading…' : children}
      </button>
    </div>
  )
}
