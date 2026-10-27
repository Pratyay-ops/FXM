import type { ReactNode } from 'react'

/**
 * A help text that only the row's own control changes, announced when it does. Help that other
 * settings change is a plain {@link Help} instead, mounted in its place, which screen readers
 * don't announce: one toggle never reads out several paragraphs.
 */
export function LiveHelp({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} aria-live="polite" className="space-y-1 text-sm text-text-muted">
      {children}
    </div>
  )
}

/** A help text that isn't announced when it changes. */
export function Help({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-sm text-text-muted">
      {children}
    </p>
  )
}
