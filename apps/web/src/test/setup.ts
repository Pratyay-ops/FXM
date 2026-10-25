import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { usePlayerStore } from '../features/player/player-store'
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
  localStorage.clear()
  delete document.documentElement.dataset.theme
})
