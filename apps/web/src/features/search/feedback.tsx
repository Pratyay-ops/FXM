import { useEffect, useState } from 'react'
import { create } from 'zustand'

/** How long a message stays on screen. */
export const FEEDBACK_MS = 4000

interface FeedbackState {
  /** The message on screen, or `''`. */
  message: string
  /**
   * When the message goes, as a `Date.now()` time. The toast can unmount before then (the user
   * opened a page without one): a toast that mounts later shows the message only for what is
   * left of its time, and not at all once that has passed.
   */
  until: number
  /** Changes with every message, so the same text shown twice restarts its timer. */
  serial: number
  show: (message: string) => void
  dismiss: () => void
}

/** The message shown after an action that has no other visible effect, like "Added to queue". */
export const useFeedbackStore = create<FeedbackState>()((set) => ({
  message: '',
  until: 0,
  serial: 0,
  show: (message) =>
    set((state) => ({ message, until: Date.now() + FEEDBACK_MS, serial: state.serial + 1 })),
  dismiss: () => set({ message: '' }),
}))

/** Shows a short confirmation, e.g. "3 songs added to the queue". */
export function showFeedback(message: string): void {
  useFeedbackStore.getState().show(message)
}

/**
 * The confirmation toast, above the player bar (or the phone's mini player and tab bar). The
 * live region is always in the page, so screen readers announce each new message.
 */
export function FeedbackToast() {
  const message = useFeedbackStore((state) => state.message)
  const until = useFeedbackStore((state) => state.until)
  const serial = useFeedbackStore((state) => state.serial)
  const dismiss = useFeedbackStore((state) => state.dismiss)
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+0.75rem)] z-50 flex justify-center px-4"
    >
      {/* A new key per message restarts the timer, also for the same text twice. */}
      {message && <Toast key={serial} message={message} until={until} onTimeout={dismiss} />}
    </div>
  )
}

function Toast({
  message,
  until,
  onTimeout,
}: {
  message: string
  until: number
  onTimeout: () => void
}) {
  // Read once, when the toast mounts: a message left over from a page before may have expired.
  const [expired] = useState(() => until <= Date.now())
  useEffect(() => {
    const timer = setTimeout(onTimeout, Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [until, onTimeout])
  if (expired) return null
  return (
    <p className="max-w-sm rounded-lg bg-text px-4 py-3 text-center text-sm font-semibold text-background shadow-lg transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0">
      {message}
    </p>
  )
}
