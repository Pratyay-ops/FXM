import '@testing-library/jest-dom/vitest'
// An in-memory IndexedDB for the library database (Dexie), one per test file.
import 'fake-indexeddb/auto'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetLibrary } from '../db/repo'
import { useAudioEffectsStore } from '../features/audio-effects/effects-store'
import { useSoundDialogStore } from '../features/audio-effects/sound-dialog-store'
import { resetDownloads } from '../features/downloads/runtime'
import { setConverter, setDeviceSaver } from '../features/downloads/save/save'
import { useLibraryViewStore } from '../features/library/view-store'
import { setLyricsProvider } from '../features/lyrics/lyrics-source'
import { resetPlayback } from '../features/now-playing/playback'
import { usePwaStore } from '../features/pwa/pwa-store'
import { useQueueReviewStore } from '../features/queue/review-store'
import { useFeedbackStore } from '../features/search/feedback'
import { useQualityStore } from '../features/settings/quality-store'
import { useSettingsStore } from '../features/settings/settings-store'
import { setSponsorBlockClient } from '../features/sponsorblock/sponsorblock-source'
import { useSponsorBlockStore } from '../features/sponsorblock/sponsorblock-store'

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

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.stubEnv('BASE_URL', WEB_BUILD_BASE)
  // The stores are app-wide singletons: give every test a fresh start.
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useQualityStore.setState(useQualityStore.getInitialState(), true)
  useQueueReviewStore.setState(useQueueReviewStore.getInitialState(), true)
  useSponsorBlockStore.setState(useSponsorBlockStore.getInitialState(), true)
  useLibraryViewStore.setState(useLibraryViewStore.getInitialState(), true)
  // The shell's toast: no confirmation carries over into the next test.
  useFeedbackStore.setState(useFeedbackStore.getInitialState(), true)
  usePwaStore.setState(usePwaStore.getInitialState(), true)
  useAudioEffectsStore.setState(useAudioEffectsStore.getInitialState(), true)
  useSoundDialogStore.setState(useSoundDialogStore.getInitialState(), true)
  if (playerStore === undefined) return
  localStorage.clear()
  sessionStorage.clear()
  // After clearing storage, so the next player restores nothing.
  resetPlayback()
  setLyricsProvider(undefined)
  setSponsorBlockClient(undefined)
  setConverter(undefined)
  setDeviceSaver(undefined)
  playerStore.usePlayerStore.setState(playerStore.usePlayerStore.getInitialState(), true)
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.titlebar
  document.documentElement.removeAttribute('style')
  // After cleanup(), so no live query still watches the database being deleted. Downloads
  // first: their manager writes to the library.
  await resetDownloads()
  await resetLibrary()
})
