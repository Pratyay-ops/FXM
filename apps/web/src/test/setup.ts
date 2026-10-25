import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setLyricsProvider } from '../features/lyrics/lyrics-source'
import { resetPlayback } from '../features/now-playing/playback'
import { usePlayerStore } from '../features/player/player-store'
import { useQueueReviewStore } from '../features/queue/review-store'
import { useSettingsStore } from '../features/settings/settings-store'
import { setSponsorBlockClient } from '../features/sponsorblock/sponsorblock-source'
import { useSponsorBlockStore } from '../features/sponsorblock/sponsorblock-store'

// findBy* and waitFor give up after 1 s by default, shorter than a lazy page's import on a
// busy machine. Waiting longer only delays real failures.
configure({ asyncUtilTimeout: 5_000 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useQueueReviewStore.setState(useQueueReviewStore.getInitialState(), true)
  useSponsorBlockStore.setState(useSponsorBlockStore.getInitialState(), true)
  localStorage.clear()
  // After clearing storage, so the next player restores nothing.
  resetPlayback()
  setLyricsProvider(undefined)
  setSponsorBlockClient(undefined)
  usePlayerStore.setState(usePlayerStore.getInitialState(), true)
  delete document.documentElement.dataset.theme
})
