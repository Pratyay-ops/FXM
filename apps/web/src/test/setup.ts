import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setLyricsProvider } from '../features/lyrics/lyrics-source'
import { resetPlayback } from '../features/now-playing/playback'
import { usePwaStore } from '../features/pwa/pwa-store'
import { useQueueReviewStore } from '../features/queue/review-store'
import { useSettingsStore } from '../features/settings/settings-store'

// findBy* and waitFor give up after 1 s by default, shorter than a lazy page's import on a
// busy machine. Waiting longer only delays real failures.
configure({ asyncUtilTimeout: 5_000 })

// Like the web build, which serves the app from /app/ (Vitest's own base is /). The installable
// web app's UI shows only there; tests of the Android and desktop builds stub '/'.
const WEB_BUILD_BASE = '/app/'
vi.stubEnv('BASE_URL', WEB_BUILD_BASE)

// The build-time PWA config tests (pwa/) run in Node, without a DOM. The player store creates
// the app's player, which needs one, as soon as it loads: load it only where there is a DOM.
const playerStore =
  typeof document === 'undefined' ? undefined : await import('../features/player/player-store')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.stubEnv('BASE_URL', WEB_BUILD_BASE)
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useQueueReviewStore.setState(useQueueReviewStore.getInitialState(), true)
  usePwaStore.setState(usePwaStore.getInitialState(), true)
  if (playerStore === undefined) return
  localStorage.clear()
  // After clearing storage, so the next player restores nothing.
  resetPlayback()
  setLyricsProvider(undefined)
  playerStore.usePlayerStore.setState(playerStore.usePlayerStore.getInitialState(), true)
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.titlebar
  document.documentElement.removeAttribute('style')
})
