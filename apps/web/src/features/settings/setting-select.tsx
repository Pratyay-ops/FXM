import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface SelectOption<V extends string> {
  value: V
  label: string
}

export interface SettingSelectProps<V extends string> {
  /** The id of the visible label (the setting row's). */
  labelledBy: string
  describedBy?: string | undefined
  value: V
  options: readonly SelectOption<V>[]
  onChange: (value: V) => void
  disabled?: boolean
  className?: string | undefined
}

/**
 * A setting with more choices than a segmented control fits on a phone: a native `<select>`,
 * so keyboards, screen readers and the phone's own picker work as the platform does. It looks
 * like the other pill controls, and follows the theme's color scheme in its menu.
 */
export function SettingSelect<V extends string>({
  labelledBy,
  describedBy,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SettingSelectProps<V>) {
  return (
    <div className={cn('relative', className)}>
      <select
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const picked = options.find((option) => option.value === event.target.value)
          if (picked) onChange(picked.value)
        }}
        // 44px touch target on phones, tablets and coarse pointers; compact with a mouse.
        className="h-touch w-full min-w-40 cursor-pointer appearance-none truncate rounded-full bg-elevated pr-10 pl-4 text-sm font-semibold text-text transition-colors duration-200 hover:bg-elevated-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-elevated forced-colors:border lg:h-10 lg:pointer-coarse:h-touch"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-text-muted',
          disabled && 'opacity-50',
        )}
      />
    </div>
  )
}
