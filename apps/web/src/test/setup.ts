import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { usePlayerStore } from '../features/player/player-store'
import { usePwaStore } from '../features/pwa/pwa-store'
import { useSettingsStore } from '../features/settings/settings-store'

// findBy* and waitFor give up after 1 s by default, shorter than a lazy page's import on a
// busy machine. Waiting longer only delays real failures.
configure({ asyncUtilTimeout: 5_000 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  usePlayerStore.setState(usePlayerStore.getInitialState(), true)
  usePwaStore.setState(usePwaStore.getInitialState(), true)
  // The build-time PWA config tests (pwa/) run in Node, without a DOM.
  if (typeof document === 'undefined') return
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.titlebar
})
