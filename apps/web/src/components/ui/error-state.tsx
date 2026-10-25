import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface ErrorStateProps {
  title: string
  message: ReactNode
  /** Technical details, shown in development builds only. */
  details?: string | undefined
  actions?: ReactNode
  className?: string
}

/** A friendly error screen with a way forward. It renders the page's <h1>. */
export function ErrorState({ title, message, details, actions, className }: ErrorStateProps) {
  return (
    <div className={cn('mx-auto flex max-w-md flex-col items-center py-16 text-center', className)}>
      <span className="grid size-16 place-items-center rounded-full bg-danger/12 text-danger">
        <CircleAlert aria-hidden="true" className="size-8" strokeWidth={1.75} />
      </span>
      <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-text-muted">{message}</p>
      {details && (
        <pre className="mt-4 max-h-40 w-full overflow-auto rounded-md bg-elevated p-3 text-left font-mono text-xs whitespace-pre-wrap text-text-muted">
          {details}
        </pre>
      )}
      {actions && <div className="mt-6 flex flex-wrap justify-center gap-3">{actions}</div>}
    </div>
  )
}
