import {
  ArrowDown,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUp,
  ArrowUpToLine,
  Dices,
  ListChecks,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import type { MoveTarget } from '../../db/ordering'
import { sameOrder } from '../../db/ordering'
import type { OrderUndo } from '../../db/types'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'
import { describeSort, directionLabel } from './sort'
import { Menu, type MenuItem } from './ui/menu'
import { defaultDirection, type SortView } from './view-store'

/** A compact toolbar button: 36 px high with a mouse, 44 px on touch screens, never narrower. */
export function chipClasses({
  pressed = false,
  tone = 'default',
}: {
  pressed?: boolean
  /** `danger` for removing things. */
  tone?: 'default' | 'danger'
} = {}): string {
  return cn(
    'inline-flex h-9 min-w-touch shrink-0 items-center justify-center gap-2 rounded-full border px-3 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-touch max-lg:h-touch [&_svg]:size-4 [&_svg]:shrink-0',
    pressed
      ? 'border-text bg-text text-background forced-colors:border-[Highlight]'
      : cn(
          'border-border-strong hover:border-text',
          tone === 'danger' ? 'text-danger' : 'text-text',
        ),
  )
}

/** How a move of several items reads: "Moved 3 songs to the top". */
const MOVE_WORDS: Readonly<Record<'top' | 'bottom' | 'up' | 'down', string>> = {
  top: 'to the top',
  bottom: 'to the bottom',
  up: 'up',
  down: 'down',
}

/**
 * What a move from a menu did, for the status toast and screen readers (drag and drop has its
 * own announcements): "Moved Creep to position 1 of 8", "Moved 3 songs to the top".
 */
export function moveMessage(
  moved: readonly string[],
  target: MoveTarget,
  order: readonly string[],
  { nameOf, noun }: { nameOf: (key: string) => string; noun: (count: number) => string },
): string {
  const [only] = moved
  if (moved.length === 1 && only !== undefined) {
    return `Moved ${nameOf(only)} to position ${order.indexOf(only) + 1} of ${order.length}`
  }
  const where = typeof target === 'string' ? ` ${MOVE_WORDS[target]}` : ''
  return `Moved ${noun(moved.length)}${where}`
}

/** The move entries of a menu, for one item at `index` of `total` or for a selection. */
export function moveMenuItems(
  onMove: (target: MoveTarget) => void,
  { index, total }: { index?: number; total?: number } = {},
): MenuItem[] {
  const first = index === 0
  const last = index !== undefined && total !== undefined && index === total - 1
  return [
    {
      id: 'top',
      label: 'Move to top',
      icon: ArrowUpToLine,
      disabled: first,
      onSelect: () => onMove('top'),
    },
    { id: 'up', label: 'Move up', icon: ArrowUp, disabled: first, onSelect: () => onMove('up') },
    {
      id: 'down',
      label: 'Move down',
      icon: ArrowDown,
      disabled: last,
      onSelect: () => onMove('down'),
    },
    {
      id: 'bottom',
      label: 'Move to bottom',
      icon: ArrowDownToLine,
      disabled: last,
      onSelect: () => onMove('bottom'),
    },
  ]
}

export interface OrderToolbarProps<K extends string> {
  /** The views on offer, "Custom order" first. */
  sorts: readonly { key: K; label: string }[]
  view: SortView<K>
  onView: (view: SortView<K>) => void
  /** What the list holds, for the Shuffle order label: "songs", "playlists". */
  plural: string
  canShuffle: boolean
  onShuffle: () => void
  selecting: boolean
  onSelecting: (on: boolean) => void
  /** The `id` of the sort button, so the notice below can give it focus. */
  sortId?: string
}

/**
 * Sort view, Shuffle order and Select, above a reorderable list. Phones have room for two
 * chips with their labels, so Shuffle order moves into the sort menu there, where it has one.
 */
export function OrderToolbar<K extends string>({
  sorts,
  view,
  onView,
  plural,
  canShuffle,
  onShuffle,
  selecting,
  onSelecting,
  sortId,
}: OrderToolbarProps<K>) {
  // Tailwind's `max-sm`: below 640 px.
  const phone = useMediaQuery('(width < 40rem)')
  const current = sorts.find((sort) => sort.key === view.key)?.label ?? ''
  const items: MenuItem[] = [
    {
      kind: 'group',
      id: 'sort',
      label: 'Sort by',
      items: sorts.map((sort) => ({
        kind: 'radio',
        id: `sort-${sort.key}`,
        label: sort.label,
        checked: view.key === sort.key,
        onSelect: () =>
          onView({
            key: sort.key,
            direction: sort.key === view.key ? view.direction : defaultDirection(sort.key),
          }),
      })),
    },
  ]
  if (view.key !== 'custom') {
    items.push({ kind: 'separator', id: 'separator' })
    items.push({
      kind: 'group',
      id: 'direction',
      label: 'Order',
      items: (['asc', 'desc'] as const).map((direction) => ({
        kind: 'radio',
        id: `direction-${direction}`,
        label: directionLabel(view.key, direction),
        checked: view.direction === direction,
        onSelect: () => onView({ key: view.key, direction }),
      })),
    })
  }
  if (phone) {
    items.push({ kind: 'separator', id: 'shuffle-separator' })
    items.push({
      id: 'shuffle',
      label: 'Shuffle order',
      icon: Dices,
      disabled: !canShuffle,
      onSelect: onShuffle,
    })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu
        label="Sort and view"
        items={items}
        className={chipClasses()}
        align="start"
        triggerId={sortId}
      >
        <ArrowDownUp aria-hidden="true" />
        <span className="sr-only">Sort: </span>
        {current}
      </Menu>
      {!phone && (
        <button
          type="button"
          className={chipClasses()}
          disabled={!canShuffle}
          onClick={onShuffle}
          title={`Put the saved order of these ${plural} in a random order. You can undo it.`}
        >
          <Dices aria-hidden="true" />
          Shuffle order
        </button>
      )}
      <button
        type="button"
        aria-pressed={selecting}
        className={chipClasses({ pressed: selecting })}
        onClick={() => onSelecting(!selecting)}
      >
        <ListChecks aria-hidden="true" />
        Select
      </button>
    </div>
  )
}

/**
 * Explains a sort view and offers to save it, or offers Undo after a shuffle or saved sort.
 * Each of its buttons changes the notice or makes it go, and its button with it: focus moves
 * to `focusAfter` (the sort button) first, so the keyboard never falls back to the page.
 */
export function OrderNotice<K extends string>({
  sorts,
  view,
  undo,
  onSave,
  onCustom,
  onUndo,
  focusAfter,
}: {
  sorts: readonly { key: K; label: string }[]
  view: SortView<K>
  undo: OrderUndo | undefined
  onSave: () => void
  onCustom: () => void
  onUndo: () => void
  focusAfter?: () => HTMLElement | null
}) {
  const link =
    'inline-flex h-touch items-center rounded-md font-semibold text-accent underline-offset-2 hover:underline lg:h-8 lg:pointer-coarse:h-touch'
  const act = (action: () => void) => () => {
    focusAfter?.()?.focus()
    action()
  }
  if (view.key !== 'custom') {
    return (
      <div className="flex flex-wrap items-center gap-x-4 rounded-lg bg-elevated px-3 py-1 text-sm">
        <p className="mr-auto py-2 text-text-muted">{describeSort(sorts, view)}.</p>
        <button type="button" className={link} onClick={act(onSave)}>
          Save as custom order
        </button>
        <button type="button" className={link} onClick={act(onCustom)}>
          Show custom order
        </button>
      </div>
    )
  }
  if (undo === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 rounded-lg bg-elevated px-3 py-1 text-sm">
      <p className="mr-auto py-2 text-text-muted">
        {undo.action === 'shuffle' ? 'The order was shuffled.' : 'The sorted order was saved.'}
      </p>
      <button type="button" className={link} onClick={act(onUndo)}>
        {undo.action === 'shuffle' ? 'Undo shuffle' : 'Undo'}
      </button>
    </div>
  )
}

/** "3 selected" with moves for the selection, the list's own actions and Clear. */
export function SelectionBar({
  count,
  noun,
  canMove,
  onMove,
  onClear,
  onSelectAll,
  children,
}: {
  count: number
  noun: string
  canMove: boolean
  onMove: (target: MoveTarget) => void
  onClear: () => void
  onSelectAll: () => void
  children?: ReactNode
}) {
  return (
    <div className="sticky top-[var(--shell-top)] z-10 -mx-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface/95 p-2 shadow-md backdrop-blur">
      <p className="mr-auto px-2 text-sm font-semibold" aria-live="polite">
        {count === 0 ? `Select ${noun} to move them` : `${count} selected`}
      </p>
      {count > 0 && canMove && (
        <Menu label="Move selected" items={moveMenuItems(onMove)} className={chipClasses()}>
          <ArrowDownUp aria-hidden="true" />
          Move
        </Menu>
      )}
      {count > 0 && children}
      <button type="button" className={chipClasses()} onClick={onSelectAll}>
        Select all
      </button>
      <IconButton label="Clear selection" icon={<X />} size="sm" onClick={onClear} />
    </div>
  )
}

/**
 * Shows a new order at once while it is saved, so a drop never flickers back to the old order,
 * a dragged row keeps focus and a saved sort shows as the custom order right away. The live
 * data takes over again once it has the new order, or with the first update after the save,
 * whatever it holds. `apply` returns what `save` returned; when that is `false` (nothing
 * changed, so no update will come), the live data takes over at once.
 */
export function useOptimisticOrder(ids: readonly string[]) {
  const [pending, setPending] = useState<{ order: string[]; settledOn?: readonly string[] } | null>(
    null,
  )

  useEffect(() => {
    if (pending === null) return
    if (sameOrder(pending.order, ids)) setPending(null)
    else if (pending.settledOn !== undefined && pending.settledOn !== ids) setPending(null)
  }, [ids, pending])

  const apply = useCallback(
    async <T,>(next: string[], save: () => Promise<T>): Promise<T> => {
      setPending({ order: next })
      try {
        const result = await save()
        setPending((current) => {
          if (current?.order !== next) return current
          return result === false ? null : { order: next, settledOn: ids }
        })
        return result
      } catch (error) {
        setPending(null)
        throw error
      }
    },
    [ids],
  )

  return { shown: pending?.order ?? ids, apply }
}

/** Buttons that act on a selection, styled for the {@link SelectionBar}. */
export function SelectionAction({
  onClick,
  children,
  danger = false,
}: {
  onClick: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      className={chipClasses({ tone: danger ? 'danger' : 'default' })}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The text button that leads an empty state somewhere. */
export const emptyActionClasses = buttonClasses({ variant: 'secondary' })
