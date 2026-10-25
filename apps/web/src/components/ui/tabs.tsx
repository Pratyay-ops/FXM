import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem<V extends string> {
  value: V
  label: string
}

export interface TabsProps<V extends string> {
  /** Accessible name of the tab list. */
  label: string
  items: readonly TabItem<V>[]
  value: V
  onChange: (value: V) => void
  /** Unique prefix for the tab and panel ids (pair with <TabPanel id=…>). */
  id: string
  className?: string
}

const tabId = (id: string, value: string) => `${id}-tab-${value}`
const panelId = (id: string) => `${id}-panel`

/**
 * Chip-style tabs following the WAI-ARIA tabs pattern: one tab stop, arrow keys,
 * Home and End move between tabs, and selection follows focus.
 */
export function Tabs<V extends string>({
  label,
  items,
  value,
  onChange,
  id,
  className,
}: TabsProps<V>) {
  const tabs = useRef(new Map<V, HTMLButtonElement>())

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targets: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: items.length - 1,
    }
    const target = targets[event.key]
    if (target === undefined) return
    event.preventDefault()
    const item = items[(target + items.length) % items.length]
    if (!item) return
    onChange(item.value)
    tabs.current.get(item.value)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        '-mx-gutter flex gap-2 overflow-x-auto px-gutter py-1.5 scrollbar-none',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node) tabs.current.set(item.value, node)
              else tabs.current.delete(item.value)
            }}
            type="button"
            role="tab"
            id={tabId(id, item.value)}
            aria-selected={selected}
            aria-controls={panelId(id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              // Forced colors (Windows High Contrast) drop the fills: outline every tab and
              // mark the selected one in system colors (adjust-none, or the browser's text
              // backplate hides the HighlightText label).
              'relative h-9 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors duration-150 after:absolute after:inset-x-0 after:-inset-y-1 forced-colors:border',
              selected
                ? 'bg-text text-background forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none forced-colors:focus-visible:outline-[CanvasText]'
                : 'bg-elevated text-text hover:bg-elevated-hover',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export interface TabPanelProps {
  /** Same `id` as the <Tabs> it belongs to. */
  id: string
  /** The selected tab's value. */
  value: string
  children: ReactNode
  className?: string
}

export function TabPanel({ id, value, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(id)}
      aria-labelledby={tabId(id, value)}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the tabs pattern makes panels focusable
      tabIndex={0}
      className={cn('rounded-md focus-visible:outline-offset-4', className)}
    >
      {children}
    </div>
  )
}
