import { type InputHTMLAttributes, useEffect, useEffectEvent, useRef } from 'react'
import { cn } from '../../lib/cn'

export interface RangeSliderProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step' | 'aria-label'
  > {
  /** Accessible name, e.g. "Seek" or "Volume". */
  label: string
  value: number
  min?: number
  max: number
  step?: number
  /** Human-readable value for screen readers, e.g. "1:05 of 3:33". */
  valueText?: string | undefined
  /** Every change, while the thumb moves. */
  onValueChange: (value: number) => void
  /**
   * The value the user settled on: when the thumb is let go, and on every key press (the
   * native `change` event). For changes that cost something, such as seeking a stream.
   */
  onValueCommit?: ((value: number) => void) | undefined
}

/** A native range input styled as a player slider (see `.range` in styles/index.css). */
export function RangeSlider({
  label,
  value,
  min = 0,
  max,
  step = 1,
  valueText,
  onValueChange,
  onValueCommit,
  className,
  style,
  ...rest
}: RangeSliderProps) {
  const ref = useRef<HTMLInputElement>(null)
  const commit = useEffectEvent((input: HTMLInputElement) => onValueCommit?.(input.valueAsNumber))
  // React's onChange fires on every `input` event; the native `change` is the commit.
  useEffect(() => {
    const input = ref.current
    if (input === null) return
    const onCommit = () => commit(input)
    input.addEventListener('change', onCommit)
    return () => input.removeEventListener('change', onCommit)
  }, [])

  const span = max - min
  const fill = span > 0 ? ((value - min) / span) * 100 : 0
  return (
    <input
      {...rest}
      ref={ref}
      type="range"
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
      className={cn('range', className)}
      style={{ ...style, '--range-fill': `${fill}%` }}
    />
  )
}
