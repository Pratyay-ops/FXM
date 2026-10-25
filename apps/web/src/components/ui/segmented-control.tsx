import type { LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../../lib/cn'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  icon?: LucideIcon
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name of the group; ignored when `labelledBy` points at a visible label. */
  label: string
  labelledBy?: string | undefined
  describedBy?: string | undefined
  value: V
  options: readonly SegmentedOption<V>[]
  onChange: (value: V) => void
  /** `sm` is the compact chip used in headers. */
  size?: 'sm' | 'md'
  className?: string | undefined
}

/**
 * A segmented control built on native radio buttons, so arrow keys, focus order
 * and screen reader semantics come from the browser. A sliding pill marks the
 * selection.
 */
export function SegmentedControl<V extends string>({
  label,
  labelledBy,
  describedBy,
  value,
  options,
  onChange,
  size = 'md',
  className,
}: SegmentedControlProps<V>) {
  const name = useId()
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn(
        // Forced colors (Windows High Contrast) drop the fills: outline the group instead.
        'relative inline-grid auto-cols-fr grid-flow-col rounded-full bg-elevated p-1 forced-colors:border',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-1 rounded-full bg-accent shadow-sm transition-transform duration-300 ease-standard"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon }) => {
        const checked = optionValue === value
        return (
          <label
            key={optionValue}
            className={cn(
              // The ::after extends the hit area to 44px+ without changing the look.
              'relative z-10 flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition-colors duration-200 select-none after:absolute after:inset-x-0 after:-inset-y-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
              size === 'md' ? 'h-10 px-3 text-sm sm:px-4' : 'h-9 px-3 text-xs',
              // The sliding pill disappears in forced colors: mark the choice in system colors
              // (adjust-none, or the browser's text backplate hides the HighlightText label).
              checked
                ? 'text-on-accent forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none forced-colors:has-[:focus-visible]:outline-[CanvasText]'
                : 'text-text-muted hover:text-text',
            )}
          >
            <input
              type="radio"
              name={name}
              value={optionValue}
              checked={checked}
              onChange={() => onChange(optionValue)}
              className="sr-only"
            />
            {Icon && <Icon aria-hidden="true" className="hidden size-4 shrink-0 xs:block" />}
            <span className="truncate">{optionLabel}</span>
          </label>
        )
      })}
    </div>
  )
}
