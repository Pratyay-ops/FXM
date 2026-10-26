/**
 * The smoke test's playlists for stage 7.3's done-when, three tracks each:
 *
 * - {@link FREE_PLAYLIST}: three public-domain recordings on Internet Archive, about 9 minutes in
 *   all, which play today;
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

/** The Internet Archive item of Musopen's recordings of Chopin's complete works. */
export const MUSOPEN_CHOPIN = 'musopen-chopin-complete-works-flac'

/**
 * Three Chopin waltzes from Musopen's recordings of his complete works, which Musopen released
 * into the public domain (CC0) after its 2012 Kickstarter; the item keeps an MP3 of each. About
 * 9 minutes in all, longest first: the page stays hidden past 5 minutes while they play, the
 * point after which Chromium, and so WebView2, throttles a hidden, silent page's timers hardest,
 * so at least one change of track and one whole track happen under it (see the README's live
 * smoke test).
 */
export const FREE_FILES = [
  {
    file: `${MUSOPEN_CHOPIN}/Waltz in F minor, Op. 70 no. 2.mp3`,
    title: 'Waltz in F minor, Op. 70 No. 2',
    seconds: 185.5,
  },
  {
    file: `${MUSOPEN_CHOPIN}/Waltz in A flat major, Op. 64 no. 3.mp3`,
    title: 'Waltz in A-flat major, Op. 64 No. 3',
    seconds: 184.2,
  },
  {
    file: `${MUSOPEN_CHOPIN}/Waltz in E minor, B. 56.mp3`,
    title: 'Waltz in E minor, B. 56',
    seconds: 175.8,
  },
] as const

/** Who the free playlist's recordings are by. */
export const FREE_ARTIST = 'Frédéric Chopin'

/** The URL of an Internet Archive file, from its `<identifier>/<file>` path. */
export function archiveUrl(path: string): string {
  return ARCHIVE_DOWNLOAD + path.split('/').map(encodeURIComponent).join('/')
}

/** The track of an Internet Archive file: `archive:track:<identifier>/<file>`. */
export function archiveTrack(file: string, title: string, artist = 'Internet Archive'): Track {
  return {
    id: formatId('archive', 'track', file),
    source: 'archive',
    title,
    artists: [{ name: artist }],
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
  tracks: FREE_FILES.map(({ file, title }) => archiveTrack(file, title, FREE_ARTIST)),
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
