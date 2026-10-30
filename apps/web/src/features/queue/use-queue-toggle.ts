import { useLocation, useNavigate } from 'react-router'

/**
 * Marks, in its history state, an entry the Queue button opened. The button opened it from a
 * page of FXM's, so the entry before it is FXM's too and going back stays in the app.
 */
const OPENED_BY_BUTTON = { openedByQueueButton: true } as const

function openedByButton(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'openedByQueueButton' in state
}

/**
 * The player bar's Queue button, a toggle: it opens the queue (Now playing's Queue tab) and,
 * while the queue is open, closes it again, back to what was open before:
 * - opened by the button: back to the page it was opened on, as the browser's Back would;
 * - opened on Now playing (its Queue tab): Now playing's lyrics;
 * - opened straight from a link or in a new tab, with nothing of FXM's before it: Home.
 * Closing replaces the queue's entry rather than adding one, so Back doesn't open it again.
 */
export function useQueueToggle() {
  const location = useLocation()
  const navigate = useNavigate()
  const open =
    location.pathname === '/now-playing' &&
    new URLSearchParams(location.search).get('tab') === 'queue'

  const toggle = () => {
    if (!open) {
      void navigate('/now-playing?tab=queue', { state: OPENED_BY_BUTTON })
    } else if (openedByButton(location.state)) {
      void navigate(-1)
    } else if (location.key !== 'default') {
      // Reached inside the app without the button: the Queue tab replaced the lyrics' entry.
      void navigate('/now-playing', { replace: true })
    } else {
      void navigate('/', { replace: true })
    }
  }

  return { open, toggle }
}
