import '@testing-library/jest-dom/vitest'
// An in-memory IndexedDB for the library database (Dexie), one per test file.
import 'fake-indexeddb/auto'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetLibrary } from '../db/repo'
import { resetDownloads } from '../features/downloads/runtime'
import { useLibraryViewStore } from '../features/library/view-store'
import { usePlayerStore } from '../features/player/player-store'
import { useSettingsStore } from '../features/settings/settings-store'

// findBy* and waitFor give up after 1 s by default, shorter than a lazy page's import on a
// busy machine. Waiting longer only delays real failures.
configure({ asyncUtilTimeout: 5_000 })

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  usePlayerStore.setState(usePlayerStore.getInitialState(), true)
  useLibraryViewStore.setState(useLibraryViewStore.getInitialState(), true)
  localStorage.clear()
  delete document.documentElement.dataset.theme
  // After cleanup(), so no live query still watches the database being deleted. Downloads
  // first: their manager writes to the library.
  await resetDownloads()
  await resetLibrary()
})
