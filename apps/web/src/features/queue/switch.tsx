import { useId } from 'react'
import { cn } from '../../lib/cn'

export interface SwitchProps {
  /** The setting's name, shown next to the switch. */
  label: string
  /** What the setting does, under the label. */
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}

/**
 * An on/off setting: a native checkbox with the switch role, so it is a single tab stop that
 * Space toggles, styled as a track and a thumb. The whole row, label included, toggles it.
 */
export function Switch({ label, description, checked, onChange, className }: SwitchProps) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <label className={cn('flex cursor-pointer items-start gap-4', className)}>
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block font-semibold">
          {label}
        </span>
        {description !== undefined && (
          <span id={descriptionId} className="mt-0.5 block text-sm text-text-muted">
            {description}
          </span>
        )}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={description === undefined ? undefined : descriptionId}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="peer absolute inset-0 size-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          className={cn(
            // Forced colors (Windows High Contrast) drop the fills: outline the track and
            // draw the thumb in system colors.
            'flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus forced-colors:border-[CanvasText]',
            checked ? 'border-accent bg-accent' : 'border-border-strong bg-elevated',
          )}
        >
          <span
            className={cn(
              'size-5.5 rounded-full shadow-sm transition-transform duration-200 ease-standard forced-colors:bg-[CanvasText]',
              checked ? 'translate-x-5 bg-on-accent forced-colors:bg-[Highlight]' : 'bg-text-muted',
            )}
          />
        </span>
      </span>
    </label>
  )
}
