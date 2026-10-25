import '@testing-library/jest-dom/vitest'
// An in-memory IndexedDB for the library database (Dexie), one per test file.
import 'fake-indexeddb/auto'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetLibrary } from '../db/repo'
import { useLibraryViewStore } from '../features/library/view-store'
import { setLyricsProvider } from '../features/lyrics/lyrics-source'
import { resetPlayback } from '../features/now-playing/playback'
import { usePlayerStore } from '../features/player/player-store'
import { useQueueReviewStore } from '../features/queue/review-store'
import { useSettingsStore } from '../features/settings/settings-store'

// findBy* and waitFor give up after 1 s by default, shorter than a lazy page's import on a
// busy machine. Waiting longer only delays real failures.
configure({ asyncUtilTimeout: 5_000 })

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useQueueReviewStore.setState(useQueueReviewStore.getInitialState(), true)
  useLibraryViewStore.setState(useLibraryViewStore.getInitialState(), true)
  localStorage.clear()
  // After clearing storage, so the next player restores nothing.
  resetPlayback()
  setLyricsProvider(undefined)
  usePlayerStore.setState(usePlayerStore.getInitialState(), true)
  delete document.documentElement.dataset.theme
  // After cleanup(), so no live query still watches the database being deleted.
  await resetLibrary()
})
