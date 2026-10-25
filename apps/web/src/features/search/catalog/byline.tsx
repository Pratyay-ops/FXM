import { APP_NAME } from '@fxm/core'
import { Fragment, type ReactNode, useEffect } from 'react'

/** A line of facts joined with middle dots, e.g. "Nova Lane · 2021 · 10 songs, 41 min". */
export function Byline({ items }: { items: readonly (readonly [key: string, ReactNode])[] }) {
  const shown = items.filter(([, node]) => node !== undefined && node !== null && node !== '')
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 sm:justify-start">
      {shown.map(([key, node], index) => (
        <Fragment key={key}>
          {index > 0 && <span aria-hidden="true">·</span>}
          <span className="min-w-0">{node}</span>
        </Fragment>
      ))}
    </p>
  )
}

/**
 * Titles the document after the entity once it has loaded ("Neon Harbor · FXM"), and gives the
 * route's own title back when the page goes.
 */
export function useEntityTitle(name: string | undefined): void {
  useEffect(() => {
    if (!name) return
    const previous = document.title
    document.title = `${name} · ${APP_NAME}`
    return () => {
      document.title = previous
    }
  }, [name])
}
