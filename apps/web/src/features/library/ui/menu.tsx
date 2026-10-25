import { Check, type LucideIcon } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../lib/cn'

/** One entry of a menu. */
export type MenuItem =
  | {
      kind?: 'action'
      id: string
      label: string
      icon?: LucideIcon
      onSelect: () => void
      disabled?: boolean
      /** Shown in the danger color, e.g. Delete. */
      danger?: boolean
    }
  | {
      /** One choice of a group, such as a sort order (`menuitemradio`). */
      kind: 'radio'
      id: string
      label: string
      checked: boolean
      onSelect: () => void
      disabled?: boolean
    }
  | { kind: 'separator'; id: string }
  | {
      /** Items under a visible heading, announced as a group, e.g. "Sort by". */
      kind: 'group'
      id: string
      label: string
      items: readonly MenuItem[]
    }

const GAP = 4
const EDGE = 8

function focusable(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)') ?? [])]
}

// The focus ring sits inside the item: the menu's scroll box would clip it outside.
const ITEM =
  'flex h-touch w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap hover:bg-elevated-hover focus-visible:bg-elevated-hover focus-visible:-outline-offset-2 disabled:opacity-40 lg:h-9 lg:pointer-coarse:h-touch'

function MenuEntry({ item, onSelect }: { item: MenuItem; onSelect: (action: () => void) => void }) {
  if (item.kind === 'separator') return <hr className="my-1 border-border" />
  if (item.kind === 'group') {
    return (
      <fieldset aria-label={item.label} className="m-0 min-w-0 border-0 p-0">
        <p
          aria-hidden="true"
          className="px-3 pt-2 pb-1 text-2xs font-bold tracking-[0.12em] text-text-muted uppercase"
        >
          {item.label}
        </p>
        {item.items.map((child) => (
          <MenuEntry key={child.id} item={child} onSelect={onSelect} />
        ))}
      </fieldset>
    )
  }
  const content = (Icon: LucideIcon | undefined) => (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        {Icon && <Icon aria-hidden="true" className="size-4" />}
      </span>
      {item.label}
    </>
  )
  if (item.kind === 'radio') {
    return (
      <button
        type="button"
        data-menu-item=""
        role="menuitemradio"
        aria-checked={item.checked}
        tabIndex={-1}
        disabled={item.disabled}
        onClick={() => onSelect(item.onSelect)}
        className={ITEM}
      >
        {content(item.checked ? Check : undefined)}
      </button>
    )
  }
  return (
    <button
      type="button"
      data-menu-item=""
      role="menuitem"
      tabIndex={-1}
      disabled={item.disabled}
      onClick={() => onSelect(item.onSelect)}
      className={cn(ITEM, item.danger && 'text-danger')}
    >
      {content(item.icon)}
    </button>
  )
}

export interface MenuPopupProps {
  /** The button that opened the menu: it is placed against it, and gets focus back. */
  anchor: HTMLElement
  items: readonly MenuItem[]
  /** Accessible name of the menu. */
  label: string
  id?: string
  /** Which edge of the anchor the menu lines up with. */
  align?: 'start' | 'end'
  /** Called when the menu closes; `returnFocus` when focus should go back to the anchor. */
  onClose: (returnFocus: boolean) => void
}

/**
 * The open menu (WAI-ARIA menu pattern): arrow keys, Home and End move through the items,
 * Escape closes it and returns focus to the anchor, and a click outside, Tab or scrolling its
 * button out of view closes it. It renders into `document.body` with fixed coordinates, so no scrolling
 * list or sidebar clips it.
 */
export function MenuPopup({ anchor, items, label, id, align = 'end', onClose }: MenuPopupProps) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  // Below the anchor, or above it when there is no room, and inside the viewport.
  const place = useCallback(() => {
    if (!menu.current) return
    const rect = anchor.getBoundingClientRect()
    const { width, height } = menu.current.getBoundingClientRect()
    const below = rect.bottom + GAP
    const top =
      below + height > window.innerHeight - EDGE && rect.top - GAP - height >= EDGE
        ? rect.top - GAP - height
        : below
    const preferred = align === 'end' ? rect.right - width : rect.left
    const left = Math.min(Math.max(EDGE, preferred), window.innerWidth - width - EDGE)
    setPosition({ top: Math.max(EDGE, top), left: Math.max(EDGE, left) })
  }, [anchor, align])

  useLayoutEffect(() => {
    place()
    focusable(menu.current)[0]?.focus()
  }, [place])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !anchor.contains(target)) onClose(false)
    }
    // Scrolling keeps the menu at its button, and closes it once the button is out of view.
    // (Scroll events arrive a frame late, so closing on any scroll would also close a menu
    // opened right after the page scrolled to its button.)
    const onScroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return
      const rect = anchor.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) onClose(false)
      else place()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose, place])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = focusable(menu.current)
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    const go = (next: number) => entries[(next + entries.length) % entries.length]?.focus()
    switch (event.key) {
      case 'ArrowDown':
        go(index + 1)
        break
      case 'ArrowUp':
        go(index - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(entries.length - 1)
        break
      case 'Escape':
        onClose(true)
        break
      case 'Tab':
        onClose(false)
        return
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const select = (action: () => void) => {
    onClose(true)
    action()
  }

  return createPortal(
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-50 max-h-[min(28rem,calc(100dvh-1rem))] min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-elevated p-1 text-text shadow-xl forced-colors:border-[CanvasText]"
      // Hidden until placed, so it never flashes at the wrong spot.
      style={
        position === null
          ? { top: 0, left: 0, visibility: 'hidden' }
          : { top: position.top, left: position.left }
      }
    >
      {items.map((item) => (
        <MenuEntry key={item.id} item={item} onSelect={select} />
      ))}
    </div>,
    document.body,
  )
}

export interface MenuProps {
  items: readonly MenuItem[]
  /** Accessible name of the trigger and the menu, e.g. "More options for Creep". */
  label: string
  /** What the trigger shows. With `iconOnly`, the label is for screen readers only. */
  children: ReactNode
  iconOnly?: boolean
  /** Classes of the trigger button. */
  className: string
  align?: 'start' | 'end'
  disabled?: boolean
}

/** A menu button: a trigger plus its {@link MenuPopup}. */
export function Menu({
  items,
  label,
  children,
  iconOnly = false,
  className,
  align = 'end',
  disabled = false,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) trigger.current?.focus()
  }, [])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={iconOnly ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={className}
      >
        {children}
      </button>
      {open && trigger.current && (
        <MenuPopup
          anchor={trigger.current}
          items={items}
          label={label}
          id={menuId}
          align={align}
          onClose={close}
        />
      )}
    </>
  )
}
