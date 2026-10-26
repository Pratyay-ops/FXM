/**
 * The smoke test's YouTube: stage 1.3's YouTube Music search and stage 1.4's stream ladder, on
 * one session, as the web app uses them (`apps/web/src/app/services/youtube.ts`). Both had not
 * merged when stage 7.2 built this test, which searched with one plain InnerTube call and left
 * the resolve waiting; stage 7.6 put them in, for its readable audio path's check.
 *
 * Every call goes through the app's native networking (`ctx.fetch`), whose transport draws each
 * InnerTube call from the request budget itself, so the ladder gets no `budget` of its own. The
 * session gets its visitorData from `sw.js_data`, as the `full` tier does.
 *
 * @module
 */

import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  type ProviderContext,
  parseId,
  type StreamOption,
} from '@fxm/core'
import type { YouTubeAudioSource, YouTubeMusicProvider } from '@fxm/sources/youtube'
import type { SmokeYouTube } from './steps'

/** The parts of stages 1.3 and 1.4 the smoke test calls. */
export interface YouTubeParts {
  /** YouTube Music's search (stage 1.3). */
  readonly music: Pick<YouTubeMusicProvider, 'search'>
  /** The stream ladder (stage 1.4). */
  readonly audio: Pick<YouTubeAudioSource, 'resolve'>
}

/** Loads stages 1.3 and 1.4 on one session, the way the web app does (lazily, as it is large). */
export async function loadYouTubeParts(): Promise<YouTubeParts> {
  const { createYouTubeAudioSource, createYouTubeProviders } = await import('@fxm/sources/youtube')
  const { session, music } = createYouTubeProviders()
  return { music, audio: createYouTubeAudioSource({ session }) }
}

/** The candidate for a YouTube Music song: its own audio, which plays without a match. */
export function songCandidate(videoId: string, title = ''): AudioCandidate {
  return {
    source: 'ytm',
    ref: videoId,
    kind: 'song',
    title,
    artists: [],
    confidence: 1,
    evidence: ['the song itself'],
  }
}

/**
 * The smoke test's YouTube: the first song of a YouTube Music search, and that song's streams,
 * best first, each probed at the end of its file where the ladder probes it.
 */
export function smokeYouTube(load: () => Promise<YouTubeParts> = loadYouTubeParts): SmokeYouTube {
  let parts: Promise<YouTubeParts> | undefined
  const get = () => {
    parts ??= load()
    return parts
  }
  return {
    async search(query: string, ctx: ProviderContext) {
      const { music } = await get()
      const results = await music.search(query, { types: ['track'] }, ctx)
      const track = results.tracks?.items[0]
      const videoId = track === undefined ? undefined : parseId(track.id)?.nativeId
      if (track === undefined || videoId === undefined) {
        throw new Error('YouTube Music found no songs')
      }
      const artists = track.artists.map((artist) => artist.name).join(', ')
      return { videoId, title: artists === '' ? track.title : `${track.title} – ${artists}` }
    },
    async resolve(videoId: string, ctx: ProviderContext): Promise<StreamOption[]> {
      const { audio } = await get()
      return audio.resolve(songCandidate(videoId), ctx, DEFAULT_QUALITY_PREFS)
    },
  }
}
