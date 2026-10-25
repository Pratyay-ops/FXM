import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { usePlayerStore } from '../features/player/player-store'
import { useSettingsStore } from '../features/settings/settings-store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  usePlayerStore.setState(usePlayerStore.getInitialState(), true)
  localStorage.clear()
  delete document.documentElement.dataset.theme
})
