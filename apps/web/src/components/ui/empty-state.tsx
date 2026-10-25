import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /** Usually a button or link that gets the user going. */
  action?: ReactNode
  /** Heading level of the title within the page (default 2). */
  headingLevel?: 2 | 3
  className?: string
}

/** Friendly "nothing here yet" message with an optional next step. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('flex flex-col items-center px-4 py-14 text-center', className)}>
      <span className="grid size-16 place-items-center rounded-full bg-elevated text-text-muted">
        <Icon aria-hidden="true" className="size-7" strokeWidth={1.75} />
      </span>
      <Heading className="mt-5 text-xl font-bold tracking-tight">{title}</Heading>
      {description && <p className="mt-2 max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
