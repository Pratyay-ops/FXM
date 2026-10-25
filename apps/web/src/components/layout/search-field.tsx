import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { cn } from '../../lib/cn'

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/**
 * Search box bound to `/search?q=`. Typing on the search page updates the query in
 * place; typing anywhere else opens the search page. While the user types, the box
 * shows its own draft (router updates are asynchronous and must not eat keystrokes);
 * otherwise it shows the URL, so back/forward and links update it.
 */
export function SearchField({
  className,
  shortcut = false,
}: {
  className?: string
  /** Focus this field when "/" is pressed outside a text field. */
  shortcut?: boolean
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!shortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      // Skip when the field is hidden (the phone layout has its own search box).
      if (!input.current || input.current.offsetParent === null) return
      event.preventDefault()
      input.current.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [shortcut])

  const onSearchPage = pathname === '/search'
  const query = onSearchPage ? (params.get('q') ?? '') : ''
  const value = draft ?? query

  const search = (next: string) => {
    setDraft(next)
    navigate(next ? `/search?q=${encodeURIComponent(next)}` : '/search', {
      // One history entry per search: the first keystroke elsewhere pushes /search,
      // the following ones replace it, so Back returns to the page the search began on.
      replace: onSearchPage,
      preventScrollReset: onSearchPage,
      // Render the new URL as soon as the router commits it (not in a transition), so
      // the next keystroke already sees /search and replaces instead of pushing again.
      flushSync: true,
    })
  }

  return (
    // <search> is the search landmark; `block` because older browsers treat it as inline.
    <search className={cn('block', className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          search(value.trim())
          input.current?.blur() // closes the on-screen keyboard on phones
        }}
      >
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-text-muted"
          />
          <input
            ref={input}
            type="search"
            name="q"
            aria-label="Search"
            placeholder="Songs, artists, albums"
            autoComplete="off"
            enterKeyHint="search"
            value={value}
            onChange={(event) => search(event.currentTarget.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && value) {
                event.preventDefault()
                search('')
              }
            }}
            className="h-11 w-full rounded-full border border-border-strong/45 bg-elevated pr-11 pl-11 text-base text-text transition-colors placeholder:text-text-muted hover:border-border-strong focus:border-border-strong [&::-webkit-search-cancel-button]:appearance-none"
          />
          {value && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                search('')
                input.current?.focus()
              }}
              // A 44px circle: exactly the rounded end of the 44px-high field.
              className="absolute top-1/2 right-0 grid size-touch -translate-y-1/2 place-items-center rounded-full text-text-muted transition-colors hover:bg-text/8 hover:text-text"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          )}
        </div>
      </form>
    </search>
  )
}
