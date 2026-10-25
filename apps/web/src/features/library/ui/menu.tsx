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

/**
 * Puts focus back on the button that opened a menu, once the menu closed: at once, so a
 * dialog that the chosen entry opens knows where focus returns; and again after the next
 * frame if focus got lost meanwhile, as when a move from the menu re-rendered the list and
 * took the row's button out of the page and back in.
 */
export function returnFocusTo(anchor: HTMLElement): void {
  anchor.focus()
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (anchor.isConnected && (active === null || active === document.body)) anchor.focus()
  })
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
  /** Which entry gets focus when the menu opens: the last one after ArrowUp on its button. */
  initialFocus?: 'first' | 'last'
  /**
   * Called when the menu closes; `returnFocus` when focus should go back to the anchor (see
   * {@link returnFocusTo}).
   */
  onClose: (returnFocus: boolean) => void
}

/**
 * The open menu (WAI-ARIA menu pattern): arrow keys, Home and End move through the items,
 * Escape closes it and returns focus to the anchor, and a click outside, Tab or scrolling its
 * button out of view closes it. It renders into `document.body` with fixed coordinates, so no
 * scrolling list or sidebar clips it.
 */
export function MenuPopup({
  anchor,
  items,
  label,
  id,
  align = 'end',
  initialFocus = 'first',
  onClose,
}: MenuPopupProps) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const focused = useRef(false)

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
  }, [place])

  // Focus moves in once the menu is placed, so it never starts at the wrong spot. Only the first
  // time: placing it again on scroll keeps focus where it is.
  useLayoutEffect(() => {
    if (position === null || focused.current) return
    focused.current = true
    const entries = focusable(menu.current)
    const entry = initialFocus === 'last' ? entries.at(-1) : entries[0]
    // A menu without an enabled entry still takes focus, so Escape and Tab close it.
    ;(entry ?? menu.current)?.focus()
  }, [position, initialFocus])

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
        // Tab moves on from the menu's button, as if the menu had never opened: the menu sits
        // at the end of the page, where Tab would leave the page.
        anchor.focus()
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
      // Transparent until placed, so it never flashes at the wrong spot. Not `visibility:
      // hidden`: browsers ignore focus() on a hidden element, and with reduced motion the global
      // 0.01 ms transitions keep the menu and its icons hidden for several frames after that.
      style={
        position === null
          ? { top: 0, left: 0, opacity: 0 }
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
  /** The trigger's `id`, so other controls can give it focus. */
  triggerId?: string | undefined
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
  triggerId,
}: MenuProps) {
  // Open with focus on the first entry, or on the last one after ArrowUp.
  const [open, setOpen] = useState<'first' | 'last' | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useCallback((returnFocus: boolean) => {
    setOpen(null)
    if (returnFocus && trigger.current) returnFocusTo(trigger.current)
  }, [])
  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        aria-label={iconOnly ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen(open ? null : 'first')}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(event.key === 'ArrowUp' ? 'last' : 'first')
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
          initialFocus={open}
          onClose={close}
        />
      )}
    </>
  )
}
