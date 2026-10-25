import { useEffect } from 'react'
import { create } from 'zustand'

interface StatusMessage {
  id: number
  text: string
  /** When it was shown, as epoch milliseconds. */
  at: number
}

interface StatusState {
  message: StatusMessage | null
  show: (text: string) => void
  dismiss: (id: number) => void
}

let nextId = 0

/** The latest confirmation or failure of a library action, e.g. "Added to Road trip". */
export const useLibraryStatus = create<StatusState>()((set) => ({
  message: null,
  show: (text) => set({ message: { id: ++nextId, text, at: Date.now() } }),
  dismiss: (id) => set((state) => (state.message?.id === id ? { message: null } : state)),
}))

/** Shows a confirmation or a failure, on every page; screen readers announce it. */
export function showStatus(text: string): void {
  useLibraryStatus.getState().show(text)
}

/** How long a message stays. Anything that needs a decision (Undo) stays on the page. */
export const STATUS_VISIBLE_MS = 5000

/**
 * The toast above the player for the library's confirmations and failures, inside a live
 * region that is always there, so screen readers announce every message. The shell renders it
 * once (`AppLayout`), so actions taken anywhere, in the sidebar say, show on every page and at
 * every width. A message older than {@link STATUS_VISIBLE_MS} never shows, so nothing pops up
 * later, out of context.
 */
export function StatusToast() {
  const message = useLibraryStatus((state) => state.message)
  const dismiss = useLibraryStatus((state) => state.dismiss)
  const fresh = message !== null && Date.now() - message.at < STATUS_VISIBLE_MS

  useEffect(() => {
    if (message === null) return
    const left = message.at + STATUS_VISIBLE_MS - Date.now()
    const timer = setTimeout(() => dismiss(message.id), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [message, dismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--shell-bottom)+0.75rem)] z-40 flex justify-center px-4"
    >
      {fresh && (
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
