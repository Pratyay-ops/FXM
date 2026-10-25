/**
 * The smoke test's playlists for stage 7.3's done-when, three tracks each:
 *
 * - {@link FREE_PLAYLIST}: three short public-domain recordings on Internet Archive, which play
 *   today;
 * - {@link youtubeSongs}: three YouTube Music songs, which wait for stage 1.4's resolver.
 *
 * @module
 */

import { type AudioCandidate, formatId, type StreamOption, type Track, tierOf } from '@fxm/core'
import type { StreamSource } from '@fxm/player'
import type { SmokePlaylist } from './playback-steps'
import { Pending } from './steps'

/** Internet Archive's download path: `/download/<identifier>/<file>`. */
export const ARCHIVE_DOWNLOAD = 'https://archive.org/download/'

/**
 * Three short recordings on Internet Archive, each in the public domain: the Public Domain
 * Mark (`long_temple_bell`) or Creative Commons' public domain dedication
 * (`onomonopoetic_sounds`). The longest plays first, so the player prepares each next track
 * while the one before plays (30 s before its end). About 2 minutes in all.
 */
export const FREE_FILES = [
  { file: 'onomonopoetic_sounds/gong.mp3', title: 'gong', seconds: 64.2 },
  { file: 'onomonopoetic_sounds/plang_pleng_pling.mp3', title: 'plang pleng pling', seconds: 31.4 },
  { file: 'long_temple_bell/long_temple_bell.mp3', title: 'long temple bell', seconds: 27 },
] as const

/** The URL of an Internet Archive file, from its `<identifier>/<file>` path. */
export function archiveUrl(path: string): string {
  return ARCHIVE_DOWNLOAD + path.split('/').map(encodeURIComponent).join('/')
}

/** The track of an Internet Archive file: `archive:track:<identifier>/<file>`. */
export function archiveTrack(file: string, title: string): Track {
  return {
    id: formatId('archive', 'track', file),
    source: 'archive',
    title,
    artists: [{ name: 'Internet Archive' }],
    artwork: [],
    kind: 'song',
  }
}

/**
 * A stream source for Internet Archive files, standing in for stage 1.6's provider: each
 * candidate's `ref` is the file's path, its stream the file's download URL, which redirects to
 * one of Internet Archive's storage hosts. Not IP-bound, never capped, never probed.
 */
export function archiveFileSource(): StreamSource {
  return {
    id: 'archive',
    async resolve(candidate: AudioCandidate): Promise<StreamOption[]> {
      return [
        {
          url: archiveUrl(candidate.ref),
          codec: 'mp3',
          container: 'mp3',
          media: 'audio',
          tier: tierOf({ codec: 'mp3' }),
          protocol: 'progressive',
          ipBound: false,
          fullLength: 'unverified',
        },
      ]
    },
  }
}

/** Three Internet Archive tracks and their source. */
export const FREE_PLAYLIST: SmokePlaylist = {
  label: 'Internet Archive tracks',
  tracks: FREE_FILES.map(({ file, title }) => archiveTrack(file, title)),
  sources: [archiveFileSource()],
}

/**
 * Three YouTube Music songs and the YouTube resolver: the real done-when, through stage 1.4's
 * ladder and its end-of-file probe. Stage 1.4 had not merged when 7.3 was built, so this waits.
 * Once it has, along these lines (with stage 1.3's provider for the search):
 *
 * ```ts
 * export async function youtubeSongs(query: string, ctx: ProviderContext) {
 *   const found = await music.search(query, { types: ['track'] }, ctx) // 1.3
 *   const tracks = (found.tracks?.items ?? []).slice(0, 3)
 *   return { label: 'YouTube Music songs', tracks, sources: [createYouTubeLadder()] } // 1.4
 * }
 * ```
 */
export async function youtubeSongs(): Promise<SmokePlaylist> {
  throw new Pending('needs stage 1.4’s VISIONOS resolver, which has not merged yet')
}
