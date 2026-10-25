/** Joins class names and skips falsy values: `cn('base', active && 'is-active')`. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
