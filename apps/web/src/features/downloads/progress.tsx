import { cn } from '../../lib/cn'

const RADIUS = 9
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * A small ring that fills as a download goes on; it turns while the size is unknown (still
 * when the user prefers reduced motion). Decorative: the button around it names the progress.
 */
export function ProgressRing({
  value,
  className,
}: {
  /** From 0 to 1, or `undefined` while unknown. */
  value: number | undefined
  className?: string
}) {
  const shown = value ?? 0.25
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn(value === undefined && 'animate-spin motion-reduce:animate-none', className)}
    >
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2.5"
      />
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - shown)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}

/**
 * A progress bar for one download, with its accessible name and value. While the size is
 * unknown it shows a sliding bar and no value.
 */
export function ProgressBar({
  value,
  label,
  valueText,
  paused = false,
}: {
  /** From 0 to 1, or `undefined` while unknown. */
  value: number | undefined
  /** Accessible name, e.g. "Download of Song". */
  label: string
  /** Human-readable value, e.g. "1.2 MB of 4.3 MB". */
  valueText?: string
  /** Paused or failed: a still, muted bar. */
  paused?: boolean
}) {
  const percent = value === undefined ? undefined : Math.round(value * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
      className="h-1 w-full overflow-hidden rounded-full bg-text/12 forced-colors:border forced-colors:border-[CanvasText]"
    >
      {percent === undefined ? (
        !paused && (
          <div className="h-full w-2/5 animate-progress rounded-full bg-accent motion-reduce:animate-none forced-colors:bg-[Highlight]" />
        )
      ) : (
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 forced-colors:bg-[Highlight]',
            paused ? 'bg-text-muted' : 'bg-accent',
          )}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  )
}
