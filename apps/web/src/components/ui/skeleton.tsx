import { cn } from '../../lib/cn'

/**
 * A shimmering placeholder block, hidden from assistive technology. Pass its size
 * and corner radius (e.g. `h-4 w-1/2 rounded-full`).
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton block', className)} />
}

/** Stable React keys for `count` placeholder items. */
export function placeholderKeys(count: number, prefix = 'placeholder'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
}

/** Generic loading state for a page that is still loading its code or data. */
export function PageSkeleton() {
  return (
    <div role="status" className="space-y-8 pt-4">
      <span className="sr-only">Loading…</span>
      <div className="space-y-3">
        <Skeleton className="h-10 w-56 max-w-full rounded-lg" />
        <Skeleton className="h-4 w-80 max-w-full rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {placeholderKeys(5, 'page').map((key) => (
          <div key={key} className="space-y-3">
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="h-3.5 w-4/5 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
