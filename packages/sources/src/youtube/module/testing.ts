/**
 * Test helpers for the YouTube module: a fake YouTube that answers a song search and the
 * `/player` calls for one song as recorded, a desktop provider context, and a way to import a
 * built module in Node. Tests only: never import this from app code.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext } from '@fxm/core'
import { BUNDLED_YOUTUBE_CONFIG } from '../config'
import searchSongs from '../fixtures/search-songs.json'
import { context, FULL, fakeInnerTube, on, onSwJsData } from '../fixtures/testing'
import { candidate, onPlayer, PLAYER_FIXTURES, VIDEOS } from '../stream/fixtures/testing'
import type { YouTubeModule } from './api'

/** The desktop app's YouTube access, without reading media bytes, so no probe runs. */
export const DESKTOP: NetworkCapabilities = { ...FULL, mediaBytes: false }

/** The `ytm` candidate of Radiohead's "Creep", whose recorded `/player` answers the fake has. */
export const SONG = candidate(VIDEOS.song)

/**
 * A fake YouTube: `sw.js_data`, a YouTube Music song search for "Radiohead Creep", and the
 * VISIONOS and ANDROID `/player` answers for "Creep", all as recorded.
 */
export function fakeYouTube() {
  return fakeInnerTube(
    onSwJsData(),
    on('search', { params: BUNDLED_YOUTUBE_CONFIG.search.music.songs }, searchSongs),
    onPlayer('VISIONOS', VIDEOS.song, PLAYER_FIXTURES['visionos-song']),
    onPlayer('ANDROID', VIDEOS.song, PLAYER_FIXTURES['android-song']),
  )
}

/** A provider context of the desktop app, with `fetch` from {@link fakeYouTube}. */
export function desktopContext(fetch: typeof globalThis.fetch): ProviderContext {
  return { ...context(fetch, { capabilities: DESKTOP, mode: 'music' }), platform: 'desktop' }
}

/** Imports a built module's code in Node, which imports `data:` URLs but not `blob:` ones. */
export async function importModuleCode(code: string): Promise<YouTubeModule> {
  const bytes = new TextEncoder().encode(code)
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(binary)}`
  )) as { youtubeModule: YouTubeModule }
  return namespace.youtubeModule
}
