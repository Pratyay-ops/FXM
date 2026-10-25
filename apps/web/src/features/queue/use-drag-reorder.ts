/**
 * Reordering a list by dragging a handle, with a mouse, a pen or a finger (pointer events), or
 * from the keyboard (the arrow keys, Home and End on the focused handle). The other rows move
 * aside while a row is dragged; the move itself happens on drop, through `onMove`.
 *
 * @module
 */

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'

/** A drag in progress. */
export interface DragState {
  /** The dragged row's index. */
  from: number
  /** Where the row would land if dropped now. */
  to: number
  /** How far the row has moved from its place, in pixels (down is positive). */
  offset: number
  /** The distance between two rows, in pixels: how far the rows it passes move aside. */
  step: number
}

/**
 * Where a dragged row lands: its index once dropped, which is the number of other rows whose
 * centre lies above the dragged row's centre.
 *
 * @param centres The centre of every row before the drag, top to bottom.
 * @param from The dragged row.
 * @param centre The dragged row's centre now.
 */
export function dropIndex(centres: readonly number[], from: number, centre: number): number {
  let index = 0
  centres.forEach((other, row) => {
    if (row !== from && other < centre) index++
  })
  return index
}

/**
 * How far row `index` moves while `drag` is in progress: the dragged row follows the pointer,
 * and the rows it passed move one step to open a gap where it would land.
 */
export function rowShift(index: number, drag: DragState): number {
  if (index === drag.from) return drag.offset
  if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step
  if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.step
  return 0
}

/** Where a key moves the row at `index` in a list of `count`, or `undefined` for other keys. */
export function keyTarget(key: string, index: number, count: number): number | undefined {
  const targets: Readonly<Record<string, number>> = {
    ArrowUp: index - 1,
    ArrowDown: index + 1,
    Home: 0,
    End: count - 1,
  }
  const target = Object.hasOwn(targets, key) ? targets[key] : undefined
  if (target === undefined || target < 0 || target >= count || target === index) return undefined
  return target
}

/** Pixels the pointer must move before a press on the handle becomes a drag. */
const DRAG_THRESHOLD = 4

/** How close to the covered edges of the window, in pixels, the window starts scrolling. */
const EDGE = 56

/** The most the window scrolls per frame while dragging near an edge, in pixels. */
const MAX_SCROLL_STEP = 14

interface Session {
  pointerId: number
  from: number
  startY: number
  startScroll: number
  lastY: number
  centres: number[]
  step: number
  dragging: boolean
  frame: number | undefined
}

export interface DragReorderOptions {
  /** The list whose element children are the rows, in order. */
  listRef: RefObject<HTMLElement | null>
  /** How many rows the list has. */
  count: number
  /**
   * Changes whenever the rows change, e.g. the list's items. A drag in progress is cancelled
   * then, because its row indices no longer hold.
   */
  rowsKey: unknown
  /** Moves the row at `from` to `to` (its index once moved). */
  onMove: (from: number, to: number, via: 'pointer' | 'keyboard') => void
}

/** The parts of the window the fixed bars cover, from the page's own scroll padding. */
function coveredEdges(): { top: number; bottom: number } {
  const style = getComputedStyle(document.documentElement)
  return {
    top: Number.parseFloat(style.scrollPaddingTop) || 0,
    bottom: Number.parseFloat(style.scrollPaddingBottom) || 0,
  }
}

/** How far the pointer has moved the row since the drag started, scrolling included. */
function offsetOf(current: Session): number {
  return current.lastY - current.startY + (window.scrollY - current.startScroll)
}

function stopScrolling(current: Session): void {
  if (current.frame !== undefined) cancelAnimationFrame(current.frame)
  current.frame = undefined
}

/**
 * Drag-to-reorder for a list. Spread `handleProps(index)` on each row's drag handle, which must
 * be a button with `touch-action: none` (so a finger drags instead of scrolling the page), and
 * apply `rowStyle(index)` to each row.
 */
export function useDragReorder({ listRef, count, rowsKey, onMove }: DragReorderOptions) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const session = useRef<Session | null>(null)

  const end = () => {
    const current = session.current
    if (current === null) return
    stopScrolling(current)
    session.current = null
    setDrag(null)
  }

  // New rows invalidate the drag's indices; an unmounted list can't be dragged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey is the trigger, not an input
  useEffect(() => {
    const current = session.current
    if (current === null) return
    stopScrolling(current)
    session.current = null
    setDrag(null)
  }, [rowsKey])
  useEffect(
    () => () => {
      const current = session.current
      if (current !== null) stopScrolling(current)
      session.current = null
    },
    [],
  )

  /** Recomputes the drag from the pointer's last position and the window's scroll. */
  const update = (current: Session) => {
    const offset = offsetOf(current)
    if (!current.dragging && Math.abs(offset) < DRAG_THRESHOLD) return
    current.dragging = true
    const centre = (current.centres[current.from] ?? 0) + offset
    const to = dropIndex(current.centres, current.from, centre)
    setDrag({ from: current.from, to, offset, step: current.step })
  }

  /** Scrolls the window while the pointer stays near a covered edge. */
  const autoScroll = (current: Session) => {
    const { top, bottom } = coveredEdges()
    const upper = top + EDGE
    const lower = window.innerHeight - bottom - EDGE
    let step = 0
    if (current.lastY < upper) step = -Math.min(MAX_SCROLL_STEP, (upper - current.lastY) / 3)
    else if (current.lastY > lower) step = Math.min(MAX_SCROLL_STEP, (current.lastY - lower) / 3)
    if (step === 0 || !current.dragging) {
      stopScrolling(current)
      return
    }
    if (current.frame !== undefined) return
    current.frame = requestAnimationFrame(() => {
      current.frame = undefined
      if (session.current !== current) return
      window.scrollBy(0, step)
      update(current)
      autoScroll(current)
    })
  }

  const start = (event: PointerEvent<HTMLElement>, index: number) => {
    const rows = Array.from(listRef.current?.children ?? [])
    const rects = rows.map((row) => row.getBoundingClientRect())
    const own = rects[index]
    if (own === undefined) return
    const neighbour = rects[index + 1] ?? rects[index - 1]
    session.current = {
      pointerId: event.pointerId,
      from: index,
      startY: event.clientY,
      startScroll: window.scrollY,
      lastY: event.clientY,
      centres: rects.map((rect) => rect.top + rect.height / 2),
      // The distance between two rows' tops, gaps included; a lone row moves by its height.
      step: neighbour === undefined ? own.height : Math.abs(neighbour.top - own.top),
      dragging: false,
      frame: undefined,
    }
  }

  const handleProps = (index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || session.current !== null) return
      event.currentTarget.setPointerCapture(event.pointerId)
      start(event, index)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = session.current
      if (current === null || current.pointerId !== event.pointerId) return
      current.lastY = event.clientY
      update(current)
      autoScroll(current)
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const current = session.current
      if (current === null || current.pointerId !== event.pointerId) return
      current.lastY = event.clientY
      const centre = (current.centres[current.from] ?? 0) + offsetOf(current)
      const to = dropIndex(current.centres, current.from, centre)
      const { from, dragging } = current
      end()
      if (dragging && to !== from) onMove(from, to, 'pointer')
    },
    onPointerCancel: end,
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
      // The browser took the pointer away (say, for a system gesture): drop the drag.
      if (session.current?.pointerId === event.pointerId) end()
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (session.current !== null) {
        // Escape cancels a drag; other keys wait for it to end.
        if (event.key === 'Escape') end()
        event.preventDefault()
        return
      }
      const to = keyTarget(event.key, index, count)
      if (to === undefined) return
      event.preventDefault()
      onMove(index, to, 'keyboard')
    },
  })

  const rowStyle = (index: number): CSSProperties | undefined => {
    if (drag === null) return undefined
    const shift = rowShift(index, drag)
    if (index === drag.from) {
      return { transform: `translateY(${shift}px)`, position: 'relative', zIndex: 10 }
    }
    return shift === 0 ? undefined : { transform: `translateY(${shift}px)` }
  }

  return { drag, handleProps, rowStyle }
}
