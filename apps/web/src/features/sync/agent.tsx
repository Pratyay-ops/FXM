import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { needsUser, syncConfigAcrossTabs, useSyncStore } from './sync-store'

interface Toast {
  id: number
  text: string
}

let toastId = 0

/**
 * Runs automatic sync while sync is on (`auto-sync.ts`, loaded only then), follows the sync
 * settings of other tabs, and says so when a sync kept two versions of a playlist or a deleted
 * one. It sits in the app layout and renders nothing else.
 */
export function SyncAgent() {
  const token = useSyncStore((state) => state.token)
  const gistId = useSyncStore((state) => state.gistId)
  const auto = useSyncStore((state) => state.auto)
  const halted = useSyncStore(
    (state) => state.problem !== undefined && needsUser(state.problem.code),
  )
  const [toast, setToast] = useState<Toast | null>(null)

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
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+0.75rem)] z-40 flex justify-center px-4"
    >
      {toast && (
        <div
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
