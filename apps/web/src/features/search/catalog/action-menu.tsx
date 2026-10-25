import { Ellipsis, type LucideIcon } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { type IconButtonSize, iconButtonClasses } from '../../../components/ui/icon-button'
import { cn } from '../../../lib/cn'

/** One entry of an {@link ActionMenu}: an action, or a link to a page. */
export type MenuAction = {
  readonly key: string
  readonly label: string
  readonly icon: LucideIcon
} & ({ readonly onSelect: () => void } | { readonly to: string })

/** Gap between the button and the menu, and between the menu and the window's edges. */
const GAP = 4
const MARGIN = 8

const itemClasses =
  'flex h-touch w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium whitespace-nowrap text-text transition-colors hover:bg-text/8 focus-visible:bg-text/8 focus-visible:-outline-offset-2 lg:h-9 lg:pointer-coarse:h-touch [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted'

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
}

/**
 * A "more options" button with a menu of actions, following the WAI-ARIA menu button pattern:
 * Enter, Space or the arrow keys open it, the arrow keys, Home and End move through it, and
 * Escape or Tab close it and return to the button. A click or tap elsewhere, scrolling or
 * resizing closes it too. The menu opens in a portal above the bars, beside the button, inside
 * the window. Renders nothing when there are no items.
 */
export function ActionMenu({
  label,
  items,
  size = 'sm',
  className,
}: {
  /** Accessible name of the button, e.g. "More options for Neon Rain". */
  label: string
  items: readonly MenuAction[]
  size?: IconButtonSize
  className?: string
}) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false)
  const [position, setPosition] = useState<{ top: number; left: number }>()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    setPosition(undefined)
    if (returnFocus) trigger.current?.focus()
  }, [])

  // Place the menu below the button (above it when there is no room), then focus an item.
  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current
    const list = menu.current
    if (!button || !list) return
    const rect = button.getBoundingClientRect()
    const width = list.offsetWidth
    const height = list.offsetHeight
    const left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN))
    const below = rect.bottom + GAP
    const top =
      below + height <= window.innerHeight - MARGIN
        ? below
        : Math.max(MARGIN, rect.top - height - GAP)
    setPosition({ top, left })
    const entries = menuItems(list)
    const target = open === 'last' ? entries.at(-1) : entries[0]
    target?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return
      close(false)
    }
    const onViewportChange = () => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, close])

  if (items.length === 0) return null

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setOpen(event.key === 'ArrowUp' ? 'last' : 'first')
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = menuItems(menu.current)
    const active = document.activeElement
    const index = active instanceof HTMLElement ? entries.indexOf(active) : -1
    const count = entries.length
    let next: HTMLElement | undefined
    switch (event.key) {
      case 'ArrowDown':
        next = entries[(index + 1) % count]
        break
      case 'ArrowUp':
        next = entries[(index - 1 + count) % count]
        break
      case 'Home':
        next = entries[0]
        break
      case 'End':
        next = entries.at(-1)
        break
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        close(true)
        return
      default:
        return
    }
    event.preventDefault()
    next?.focus()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open !== false}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen('first'))}
        onKeyDown={onTriggerKeyDown}
        className={iconButtonClasses({ size, highlighted: open !== false, className })}
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            className={cn(
              'fixed z-50 min-w-52 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-elevated p-1 shadow-xl',
              // Measured first, then placed: hidden from view (not from focus) until placed.
              position === undefined && 'opacity-0',
            )}
            style={position}
          >
            {items.map((item) => {
              const Icon = item.icon
              return 'to' in item ? (
                <Link
                  key={item.key}
                  to={item.to}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => close(false)}
                  className={itemClasses}
                >
                  <Icon aria-hidden="true" />
                  {item.label}
                </Link>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    // Back to the button first, so a dialog the action opens returns there.
                    close(true)
                    item.onSelect()
                  }}
                  className={itemClasses}
                >
                  <Icon aria-hidden="true" />
                  {item.label}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
