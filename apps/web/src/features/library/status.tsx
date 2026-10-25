import { useEffect } from 'react'
import { create } from 'zustand'

interface StatusMessage {
  id: number
  text: string
}

interface StatusState {
  message: StatusMessage | null
  show: (text: string) => void
  dismiss: (id: number) => void
}

let nextId = 0

/** The latest confirmation of a library action, e.g. "Added to Road trip". */
export const useLibraryStatus = create<StatusState>()((set) => ({
  message: null,
  show: (text) => set({ message: { id: ++nextId, text } }),
  dismiss: (id) => set((state) => (state.message?.id === id ? { message: null } : state)),
}))

/** Shows a confirmation; screen readers announce it. */
export function showStatus(text: string): void {
  useLibraryStatus.getState().show(text)
}

/** How long a confirmation stays. Anything that needs a decision (Undo) stays on the page. */
const VISIBLE_MS = 5000

/**
 * The toast above the player for library confirmations, inside a live region that is always
 * there, so screen readers announce every message.
 */
export function StatusToast() {
  const message = useLibraryStatus((state) => state.message)
  const dismiss = useLibraryStatus((state) => state.dismiss)

  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(() => dismiss(message.id), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [message, dismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+0.75rem)] z-40 flex justify-center px-4"
    >
      {message && (
        <p
          key={message.id}
          className="max-w-md rounded-xl bg-text px-4 py-2.5 text-sm font-semibold text-background shadow-lg transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0 forced-colors:border"
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
