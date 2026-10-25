import type { InputHTMLAttributes } from 'react'
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
  onValueChange: (value: number) => void
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
  className,
  style,
  ...rest
}: RangeSliderProps) {
  const span = max - min
  const fill = span > 0 ? ((value - min) / span) * 100 : 0
  return (
    <input
      {...rest}
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
