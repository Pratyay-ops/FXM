import { cn } from '../../lib/cn'

export interface SettingSwitchProps {
  /** The id of the visible label (the setting row's). */
  labelledBy: string
  describedBy?: string | undefined
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string | undefined
}

/**
 * An on/off setting, shown as the platforms show one (iOS toggles, Material switches): a
 * `switch` button, so Space and Enter toggle it and screen readers say "on" or "off". The track
 * is neutral when off (`border-strong`, at least 3:1 against the card) and the accent when on;
 * forced colors (Windows High Contrast) outline it and draw the thumb in system colors.
 */
export function SettingSwitch({
  labelledBy,
  describedBy,
  checked,
  onChange,
  className,
}: SettingSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={cn(
        // The ::after extends the hit area to 64 × 44 px without changing the look or the
        // layout, so the track lines up with the row's label and the other controls.
        'relative block h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors duration-200 after:absolute after:-inset-x-2 after:-inset-y-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus forced-colors:border forced-colors:border-[CanvasText]',
        checked ? 'bg-accent' : 'bg-border-strong',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // Forced colors add a 1px border to the track: inset the thumb by 1px less.
          'absolute top-0.5 left-0.5 size-6 rounded-full shadow-sm transition-transform duration-200 ease-standard forced-colors:top-px forced-colors:left-px forced-colors:forced-color-adjust-none',
          checked
            ? 'translate-x-5 bg-on-accent forced-colors:bg-[Highlight]'
            : 'bg-white forced-colors:bg-[CanvasText]',
        )}
      />
    </button>
  )
}
