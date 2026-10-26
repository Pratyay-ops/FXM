/**
 * Drag and drop for the library's lists, on dnd-kit: its pointer, touch and keyboard sensors,
 * auto-scrolling and screen-reader announcements. Lists render their rows with
 * {@link useSortableItem}; a drop becomes a `MoveTarget`, which the repository saves.
 *
 * Moving rows with buttons (move up, down, to the top or bottom) doesn't need this: lists call
 * the repository's `moveItems` directly.
 *
 * @module
 */

import {
  type Announcements,
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MoveTarget } from '../../db/ordering'

/**
 * Where the dragged items go when the item `activeId` is dropped over `overId`, as sortable
 * lists show it: moving down, they land after the item they were dropped on; moving up,
 * before it. `null` when the drop changes nothing.
 */
export function dropTarget(
  ids: readonly string[],
  activeId: string,
  overId: string,
): MoveTarget | null {
  const from = ids.indexOf(activeId)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return null
  return to > from ? { before: ids[to + 1] ?? null } : { before: overId }
}

/** What is being dragged right now. */
interface DragState {
  /** The item under the pointer or keyboard. */
  activeId: string | null
  /** Every item that moves with it: the selection, when the active item is selected. */
  moving: ReadonlySet<string>
  /** Whether rows slide out of the way: only in lists short enough to animate cheaply. */
  animate: boolean
}

/**
 * Longest list whose rows slide out of the way while dragging. Longer lists skip the
 * transitions: styling thousands of rows at once would make picking a row up feel slow.
 */
const ANIMATED_ROWS = 200

const NOTHING: DragState = { activeId: null, moving: new Set(), animate: true }
const DragStateContext = createContext<DragState>(NOTHING)

/** What is being dragged in the surrounding {@link SortableList}. */
export function useDragState(): DragState {
  return useContext(DragStateContext)
}

/** The sortable props of one row: put `setNodeRef` and `style` on the row element. */
export function useSortableItem(id: string) {
  const { animate } = useContext(DragStateContext)
  const sortable = useSortable(animate ? { id } : { id, transition: null })
  return {
    ...sortable,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
    },
  }
}

export interface SortableListProps {
  /** The keys in the order shown. */
  ids: readonly string[]
  /** Whether items can be dragged now: only the custom order can change. */
  enabled: boolean
  /** Dragging a selected item moves every selected item. */
  selection: ReadonlySet<string>
  /** An item's name, for announcements and the drag preview. */
  labelOf: (id: string) => string
  /** What several items are called: "songs", "playlists". */
  plural: string
  /** Saves a move. */
  onMove: (keys: string[], target: MoveTarget) => void
  /**
   * `handle` (default): a drag starts from each row's handle, with a pointer, touch or the
   * keyboard. `row`: from the row itself, once the mouse moves a few pixels or after a long
   * press on touch, so taps and scrolling still work; keyboard users use the move buttons.
   */
  activator?: 'handle' | 'row'
  /** Classes of the element around the list, e.g. to let it fill a column. */
  className?: string
  children: ReactNode
}

/** A list whose rows can be dragged into a new order. */
export function SortableList({
  ids,
  enabled,
  selection,
  labelOf,
  plural,
  onMove,
  activator = 'handle',
  className,
  children,
}: SortableListProps) {
  const [drag, setDrag] = useState<Omit<DragState, 'animate'>>(NOTHING)
  const animate = ids.length <= ANIMATED_ROWS
  const state = useMemo(() => ({ ...drag, animate }), [drag, animate])
  // Releasing a pointer drag over a link would also click it: skip that one click.
  const swallowClick = useRef(false)
  const pointerDrag = useRef(false)
  // Where the dragged item was last announced, so pick-up isn't drowned out by "moved to" its
  // own place, which dnd-kit reports right after.
  const announcedOver = useRef<UniqueIdentifier | null>(null)

  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  const keyboard = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const mouse = useSensor(MouseSensor, { activationConstraint: { distance: 6 } })
  const touch = useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } })
  const sensors = useSensors(...(activator === 'row' ? [mouse, touch] : [pointer, keyboard]))

  const movingWith = (id: string): string[] =>
    selection.has(id) ? ids.filter((key) => selection.has(key)) : [id]
  const nameOf = (id: UniqueIdentifier) => {
    const count = movingWith(String(id)).length
    return count > 1 ? `${count} ${plural}` : labelOf(String(id))
  }
  const place = (id: UniqueIdentifier) => `${ids.indexOf(String(id)) + 1} of ${ids.length}`

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      announcedOver.current = active.id
      return `Picked up ${nameOf(active.id)}, at position ${place(active.id)}.`
    },
    onDragOver: ({ active, over }) => {
      const target = over?.id ?? null
      if (target === announcedOver.current) return undefined
      announcedOver.current = target
      return target === null
        ? `${nameOf(active.id)} is no longer over the list.`
        : `${nameOf(active.id)} moved to position ${place(target)}.`
    },
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} dropped at position ${place(over.id)}.`
        : `${nameOf(active.id)} dropped back in place.`,
    onDragCancel: ({ active }) =>
      `Moving cancelled. ${nameOf(active.id)} went back to position ${place(active.id)}.`,
  }

  const finish = () => {
    if (pointerDrag.current) {
      swallowClick.current = true
      // The click comes right after the release, if at all; never hold on to the flag.
      setTimeout(() => {
        swallowClick.current = false
      }, 400)
    }
    setDrag(NOTHING)
  }

  const items = useMemo(() => [...ids], [ids])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{ announcements }}
      onDragStart={({ active, activatorEvent }) => {
        const id = String(active.id)
        pointerDrag.current = !(activatorEvent instanceof KeyboardEvent)
        setDrag({ activeId: id, moving: new Set(movingWith(id)) })
      }}
      onDragEnd={({ active, over }) => {
        const id = String(active.id)
        const keys = movingWith(id)
        finish()
        if (!over) return
        const target = dropTarget(ids, id, String(over.id))
        if (target !== null) onMove(keys, target)
      }}
      onDragCancel={finish}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy} disabled={!enabled}>
        <DragStateContext.Provider value={state}>
          {/* A drag that ends over a link must not also open it. */}
          <div
            className={className}
            onClickCapture={(event) => {
              if (!swallowClick.current) return
              swallowClick.current = false
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            {children}
          </div>
        </DragStateContext.Provider>
      </SortableContext>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {drag.activeId === null ? null : (
            <div className="inline-flex max-w-72 items-center rounded-lg bg-text px-3 py-2 text-sm font-semibold text-background shadow-xl">
              <span className="truncate">{nameOf(drag.activeId)}</span>
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
