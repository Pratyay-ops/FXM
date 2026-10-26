import { X } from 'lucide-react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { needsUser, syncConfigAcrossTabs, useSyncStore } from './sync-store'

interface Toast {
  id: number
  text: string
}

let toastId = 0

/**
 * The room the toast takes above the player, its height plus a gap, kept on <html> while it
 * shows. The app's confirmation toast (`FeedbackToast` in features/search/feedback.tsx) shows in
 * the same spot and rises by as much, so neither covers the other.
 */
export const SYNC_TOAST_SPACE_PROPERTY = '--sync-toast-space'

/**
 * Keeps {@link SYNC_TOAST_SPACE_PROPERTY} on <html> while the toast `id` shows, following its
 * height, which grows when its text wraps (a narrow window, or large text).
 */
function useSpaceAbovePlayer(toast: RefObject<HTMLElement | null>, id: number | undefined): void {
  useLayoutEffect(() => {
    const element = toast.current
    if (id === undefined || element === null) return
    const root = document.documentElement
    const update = () =>
      root.style.setProperty(SYNC_TOAST_SPACE_PROPERTY, `calc(${element.offsetHeight}px + 0.5rem)`)
    update()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(element)
    return () => {
      resize?.disconnect()
      root.style.removeProperty(SYNC_TOAST_SPACE_PROPERTY)
    }
  }, [toast, id])
}

/**
 * Runs automatic sync while sync is on (`auto-sync.ts`, loaded only then), follows the sync
 * settings of other tabs, and says so when a sync kept two versions of a playlist or a deleted
 * one. It sits in the app layout and renders nothing else.
 *
 * Its toast shows where the app's other toasts do, above the player bar (or the phone's mini
 * player and tab bar), so none covers another: it rises above the cards SponsorBlock stacks
 * there (`--shell-cards`), the FXM Connect notice (`--connect-notice-space`) and the installable
 * app's update toast (`--update-toast-space`), and the app's confirmations rise above it
 * ({@link SYNC_TOAST_SPACE_PROPERTY}).
 */
export function SyncAgent() {
  const token = useSyncStore((state) => state.token)
  const gistId = useSyncStore((state) => state.gistId)
  const auto = useSyncStore((state) => state.auto)
  const halted = useSyncStore(
    (state) => state.problem !== undefined && needsUser(state.problem.code),
  )
  const [toast, setToast] = useState<Toast | null>(null)
  const shown = useRef<HTMLDivElement>(null)
  useSpaceAbovePlayer(shown, toast?.id)

  useEffect(() => syncConfigAcrossTabs(), [])

  useEffect(() => {
    if (token === undefined || gistId === undefined || !auto || halted) return
    let stop: (() => void) | undefined
    let cancelled = false
    void import('./auto-sync').then(({ startAutoSync }) => {
      if (cancelled) return
      stop = startAutoSync((text) => setToast({ id: ++toastId, text }))
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [token, gistId, auto, halted])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      10_000,
    )
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+var(--shell-cards,0px)+var(--update-toast-space,0px)+var(--connect-notice-space,0px)+0.75rem)] z-40 flex justify-center px-4"
    >
      {toast && (
        <div
          ref={shown}
          key={toast.id}
          className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-text py-1.5 pr-1.5 pl-4 text-sm font-semibold text-background shadow-lg transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0 forced-colors:border"
        >
          <p>
            {toast.text}{' '}
            <Link to="/settings" className="underline" onClick={() => setToast(null)}>
              Review
            </Link>
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            className="inline-flex size-touch shrink-0 items-center justify-center rounded-full transition-colors hover:bg-background/15 [&_svg]:size-4"
            onClick={() => setToast(null)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
