import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

/**
 * Tells screen reader users that a link opened another page: a client-side
 * navigation announces nothing by itself, and focus stays on the link. Speaks
 * when the path changes, not on the first render or when only the query changes
 * (typing a search).
 */
export function RouteAnnouncer({ title }: { title: string }) {
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    const next = `Navigated to ${title}`
    // A live region only speaks when its text changes (album to album has the same title).
    setMessage((previous) => (previous === next ? `${next} ` : next))
  }, [pathname, title])

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  )
}
