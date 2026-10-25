import { type ReactNode, useId } from 'react'
import { cn } from '../../lib/cn'

export interface PageTitleProps {
  children: ReactNode
  /**
   * Visually hide the title below 768px, where the top bar already shows it.
   * It stays in the accessibility tree as the page's <h1>.
   */
  hideOnPhone?: boolean
  className?: string
}

export function PageTitle({ children, hideOnPhone = false, className }: PageTitleProps) {
  return (
    <h1
      className={cn(
        'text-3xl font-extrabold tracking-tight md:text-4xl',
        hideOnPhone && 'max-md:sr-only',
        className,
      )}
    >
      {children}
    </h1>
  )
}

export interface ShelfProps {
  title: string
  description?: string
  children: ReactNode
  className?: string
}

/** A titled row of content, like the shelves on a music app's home page. */
export function Shelf({ title, description, children, className }: ShelfProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn('space-y-4', className)}>
      <div>
        <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}
