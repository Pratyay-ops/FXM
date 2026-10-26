import { RefreshCw } from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'
import { moveFocus } from './focus'
import { usePwaStore } from './pwa-store'

/**
 * The room the toast takes above the player, its height plus a gap, kept on <html> while it
 * shows there. The app's confirmation toast (`FeedbackToast` in features/search/feedback.tsx)
 * shows in the same spot and rises by as much, so neither covers the other.
 */
export const TOAST_SPACE_PROPERTY = '--update-toast-space'

/** Phones (Tailwind's `max-md`), where a full-screen page puts the toast at the top instead. */
export const PHONE_QUERY = '(width < 48rem)'

/**
 * Keeps {@link TOAST_SPACE_PROPERTY} on <html> while `active`, following the toast's height,
 * which grows when its buttons wrap (a narrow window, or large text).
 */
function useSpaceAbovePlayer(toast: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = toast.current
    if (!active || element === null) return
    const root = document.documentElement
    const update = () =>
      root.style.setProperty(TOAST_SPACE_PROPERTY, `calc(${element.offsetHeight}px + 0.5rem)`)
    update()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(element)
    return () => {
      resize?.disconnect()
      root.style.removeProperty(TOAST_SPACE_PROPERTY)
    }
  }, [toast, active])
}

/**
 * Offers a waiting new version of FXM, above the player. The app never reloads by itself,
 * because that would stop the music: "Reload" switches to the new version now, "Not now" (or
 * Escape) keeps this one, and the new version starts the next time FXM opens.
 *
 * It is a landmark ("App update"), so screen reader users can jump to it. When "Not now" or
 * Escape removes it, focus goes back to where it came from (or to the page). Confirmations
 * shown meanwhile appear above it ({@link TOAST_SPACE_PROPERTY}).
 */
export function UpdateToast({ fullScreen = false }: { fullScreen?: boolean }) {
  const show = usePwaStore((state) => state.updateReady && !state.updateDismissed)
  const applyUpdate = usePwaStore((state) => state.applyUpdate)
  const phone = useMediaQuery(PHONE_QUERY)
  const toast = useRef<HTMLElement>(null)
  /** The element focus came from when it entered the toast. */
  const cameFrom = useRef<Element | null>(null)
  // On a phone's Now Playing the toast sits at the top, away from the confirmations.
  useSpaceAbovePlayer(toast, show && !(fullScreen && phone))

  const dismiss = () => {
    const hadFocus = toast.current?.contains(document.activeElement) ?? false
    usePwaStore.setState({ updateDismissed: true })
    if (hadFocus) moveFocus(cameFrom.current)
  }

  return (
    // The live region stays in the page, so screen readers announce the toast when it appears
    // (a plain live region, like the route announcer's: role="status" is the loading skeleton's).
    // From 768px it centres on the page column, beside the sidebar. On a phone's full-screen
    // Now Playing it sits below the top bar, clear of the big player controls.
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+0.75rem)] z-50 flex justify-center px-gutter md:pl-[calc(var(--spacing-rail)+var(--spacing-gutter))] lg:pl-[calc(var(--spacing-sidebar)+var(--spacing-gutter))]',
        fullScreen && 'max-md:top-[calc(var(--shell-top)+0.5rem)] max-md:bottom-auto',
      )}
    >
      {show && (
        <section
          ref={toast}
          aria-label="App update"
          className="pointer-events-auto flex w-full max-w-lg flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-xl border border-border bg-elevated py-2 pr-2 pl-4 shadow-xl"
          onFocus={(event) => {
            const from = event.relatedTarget
            if (!(from instanceof Node && event.currentTarget.contains(from))) {
              cameFrom.current = from instanceof Element ? from : null
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            dismiss()
          }}
        >
          <p className="flex min-w-0 flex-1 basis-52 items-center gap-3 py-1 text-sm font-semibold">
            <RefreshCw aria-hidden="true" className="size-5 shrink-0 text-accent" />A new version of
            FXM is ready.
          </p>
          {/* Wraps with large text; the gap keeps one button's focus ring off the other. */}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={dismiss}>
              Not now
            </button>
            <button type="button" className={buttonClasses()} onClick={() => void applyUpdate()}>
              Reload
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
