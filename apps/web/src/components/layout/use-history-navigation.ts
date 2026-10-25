import { useEffect, useState } from 'react'
import { useNavigate, useNavigationType } from 'react-router'

/** Position of the current entry in this tab's history, as stored by React Router. */
function historyIndex(): number {
  const state: unknown = typeof window === 'undefined' ? null : window.history.state
  if (typeof state === 'object' && state !== null && 'idx' in state) {
    return typeof state.idx === 'number' ? state.idx : 0
  }
  return 0
}

/**
 * Back and forward for the top bar, with enabled states like a browser's:
 * back is possible past the first in-app entry, forward after going back.
 */
export function useHistoryNavigation() {
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const index = historyIndex()
  const [furthest, setFurthest] = useState(index)

  useEffect(() => {
    // A push drops the forward entries; going back or forward keeps them.
    setFurthest((previous) => (navigationType === 'PUSH' ? index : Math.max(previous, index)))
  }, [index, navigationType])

  return {
    canGoBack: index > 0,
    canGoForward: index < furthest,
    goBack: () => navigate(-1),
    goForward: () => navigate(1),
  }
}
