import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-elevated text-text hover:bg-elevated-hover',
  ghost: 'text-text-muted hover:bg-text/8 hover:text-text',
}

/** Classes for text buttons; works on <button> and on router <Link>s alike. */
export function buttonClasses({
  variant = 'primary',
  className,
}: {
  variant?: ButtonVariant
  className?: string | undefined
} = {}): string {
  return cn(
    'inline-flex h-touch shrink-0 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold whitespace-nowrap transition-[color,background-color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none [&_svg]:size-4 [&_svg]:shrink-0',
    variants[variant],
    className,
  )
}
