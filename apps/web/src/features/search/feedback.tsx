import { useEffect } from 'react'
import { create } from 'zustand'

/** How long a message stays on screen. */
export const FEEDBACK_MS = 4000

interface FeedbackState {
  /** The message on screen, or `''`. */
  message: string
  /** Changes with every message, so the same text shown twice restarts its timer. */
  serial: number
  show: (message: string) => void
  dismiss: () => void
}

/** The message shown after an action that has no other visible effect, like "Added to queue". */
export const useFeedbackStore = create<FeedbackState>()((set) => ({
  message: '',
  serial: 0,
  show: (message) => set((state) => ({ message, serial: state.serial + 1 })),
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
  const serial = useFeedbackStore((state) => state.serial)
  const dismiss = useFeedbackStore((state) => state.dismiss)
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+0.75rem)] z-50 flex justify-center px-4"
    >
      {/* A new key per message restarts the timer, also for the same text twice. */}
      {message && <Toast key={serial} message={message} onTimeout={dismiss} />}
    </div>
  )
}

function Toast({ message, onTimeout }: { message: string; onTimeout: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onTimeout, FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [onTimeout])
  return (
    <p className="max-w-sm rounded-lg bg-text px-4 py-3 text-center text-sm font-semibold text-background shadow-lg transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0">
      {message}
    </p>
  )
}
