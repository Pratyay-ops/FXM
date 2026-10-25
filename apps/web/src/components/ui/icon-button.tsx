import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** `custom` applies no size classes: pass your own (keep touch targets >= 44px). */
export type IconButtonSize = 'sm' | 'md' | 'lg' | 'custom'
export type IconButtonVariant = 'ghost' | 'plain' | 'solid' | 'contrast' | 'accent'

// 44px touch targets on phones, tablets and any coarse pointer; compact with a mouse.
const sizes: Record<IconButtonSize, string> = {
  sm: 'size-touch lg:size-8 lg:pointer-coarse:size-touch [&_svg]:size-5 lg:[&_svg]:size-[1.125rem]',
  md: 'size-touch lg:size-10 lg:pointer-coarse:size-touch [&_svg]:size-5',
  lg: 'size-14 [&_svg]:size-6',
  custom: '',
}

const variants: Record<IconButtonVariant, string> = {
  ghost: 'text-text-muted hover:bg-text/8 hover:text-text',
  plain: 'text-text hover:bg-text/8',
  solid: 'bg-elevated text-text hover:bg-elevated-hover',
  contrast: 'bg-text text-background hover:scale-105',
  accent: 'bg-accent text-on-accent shadow-md hover:scale-105 hover:bg-accent-hover',
}

// Ghost and plain buttons show their "on" state in the accent color.
const highlightedVariant = 'text-accent hover:bg-text/8'

export interface IconButtonStyle {
  size?: IconButtonSize | undefined
  variant?: IconButtonVariant | undefined
  /** Accent color, for toggles that are on (ghost and plain variants). */
  highlighted?: boolean | undefined
  /** Adds a small dot under highlighted buttons, so the state does not rely on color. */
  dot?: boolean | undefined
  className?: string | undefined
}

/** Classes for round icon-only controls; also used to style links as icon buttons. */
export function iconButtonClasses({
  size = 'md',
  variant = 'ghost',
  highlighted = false,
  dot = false,
  className,
}: IconButtonStyle = {}): string {
  const tinted = highlighted && (variant === 'ghost' || variant === 'plain')
  return cn(
    'relative inline-flex shrink-0 items-center justify-center rounded-full transition-[color,background-color,transform] duration-150 active:scale-95 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transform-none',
    sizes[size],
    tinted ? highlightedVariant : variants[variant],
    tinted &&
      dot &&
      'after:absolute after:bottom-0.5 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-accent',
    className,
  )
}

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'type'>,
    Omit<IconButtonStyle, 'highlighted'> {
  /** Accessible name: icon-only buttons always need one. */
  label: string
  icon: ReactNode
  /** Makes the button a toggle (aria-pressed) and highlights it when pressed. */
  pressed?: boolean | undefined
  /** Highlights the button without making it a toggle (e.g. repeat, whose label changes). */
  active?: boolean | undefined
}

export function IconButton({
  label,
  icon,
  size,
  variant,
  dot,
  pressed,
  active,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={iconButtonClasses({
        size,
        variant,
        dot,
        highlighted: pressed ?? active ?? false,
        className,
      })}
    >
      {icon}
    </button>
  )
}
