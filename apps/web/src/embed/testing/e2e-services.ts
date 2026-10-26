/**
 * The embed's providers in the browser tests' build (`vite build --mode e2e`, see `e2e/embed`).
 * Stages 1.3, 1.4 and 1.6 hadn't merged when the embed was built, so these doubles stand in
 * for them behind the same interfaces:
 *
 * - **Metadata** comes from fixtures (`e2e-fixtures.ts`), without a request.
 * - **YouTube streams** resolve through the real platform, as stage 1.4's ladder will: one
 *   `/player` call per rung through `ctx.fetch`, which in the Lite tier goes through the
 *   sandbox document to the test network's InnerTube mock. The top rung asks as VISIONOS, the
 *   fallback rung as ANDROID for itag 18. URLs come back `unverified` where the bytes can't be
 *   read, so the media element's first request is the probe (stage 2.3).
 * - **Internet Archive** resolves to the test network's file host, with no request first.
 *
 * Only the mock answers these requests: the client fields are the bare minimum it reads, not
 * what YouTube needs. Never part of a production build.
 *
 * @module
 */

import {
  type Album,
  FxmError,
  formatId,
  type Playlist,
  type ProviderContext,
  type StreamOption,
  type Track,
} from '@fxm/core'
import type { StreamSource } from '@fxm/player'
import { createProviderCatalog, type EmbedAttribution } from '../catalog'
import type { EmbedPlatform, EmbedServices } from '../controller'
import {
  E2E_ALBUM,
  E2E_ARCHIVE_HOST,
  E2E_ARCHIVE_NATIVE_ID,
  E2E_ARCHIVE_TRACK,
  E2E_PLAYLIST,
  E2E_SONGS,
  E2E_VIDEO,
  type E2eSong,
} from './e2e-fixtures'
import { FakeMetadataProvider, fixtureTrack } from './fake-provider'

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'

/** The client each rung asks as; the mock answers VISIONOS with Opus 251, ANDROID with itag 18. */
const CLIENTS = {
  top: { clientName: 'VISIONOS', clientVersion: '1.02' },
  fallback: { clientName: 'ANDROID', clientVersion: '21.26.364' },
} as const

/** How long the mock's URLs count as valid: 6 hours, like YouTube's. */
const URL_LIFETIME_MS = 6 * 60 * 60_000

const songTrack = (song: E2eSong, album?: { name: string; id: Album['id'] }): Track =>
  fixtureTrack('ytm', song.videoId, {
    title: song.title,
    artists: [{ name: song.artist }],
    durationMs: song.durationMs,
    ...(album === undefined ? {} : { album }),
  })

function fixtures() {
  const albumId = formatId('ytm', 'album', E2E_ALBUM.browseId)
  const albumRef = { name: E2E_ALBUM.name, id: albumId }
  const album: Album = {
    id: albumId,
    source: 'ytm',
    name: E2E_ALBUM.name,
    artists: [{ name: E2E_ALBUM.artist }],
    artwork: [],
    type: 'album',
    trackCount: E2E_ALBUM.songs.length,
    tracks: E2E_ALBUM.songs.map((song) => songTrack(song, albumRef)),
  }
  const playlistTracks = E2E_PLAYLIST.songs.map((song) => songTrack(song))
  const playlist: Playlist = {
    id: formatId('ytm', 'playlist', E2E_PLAYLIST.playlistId),
    source: 'ytm',
    name: E2E_PLAYLIST.name,
    owner: { name: E2E_PLAYLIST.owner },
    artwork: [],
    trackCount: playlistTracks.length,
    tracks: { items: playlistTracks },
  }
  const video = fixtureTrack('ytm', E2E_VIDEO.videoId, {
    title: E2E_VIDEO.title,
    artists: [{ name: E2E_VIDEO.artist }],
    durationMs: E2E_VIDEO.durationMs,
    kind: 'music-video',
  })
  const archive = fixtureTrack('archive', E2E_ARCHIVE_NATIVE_ID, {
    title: E2E_ARCHIVE_TRACK.title,
    artists: [{ name: E2E_ARCHIVE_TRACK.artist }],
    durationMs: E2E_ARCHIVE_TRACK.durationMs,
  })
  return {
    youtube: new FakeMetadataProvider('ytm', {
      tracks: [...Object.values(E2E_SONGS).map((song) => songTrack(song)), video],
      albums: [album],
      playlists: [playlist],
    }),
    archive: new FakeMetadataProvider('archive', { tracks: [archive] }),
  }
}

/** The part of a `/player` answer the double reads. */
interface PlayerAnswer {
  readonly playabilityStatus?: { readonly status?: unknown }
  readonly videoDetails?: { readonly videoId?: unknown }
  readonly streamingData?: {
    readonly adaptiveFormats?: readonly { readonly itag?: unknown; readonly url?: unknown }[]
    readonly formats?: readonly { readonly itag?: unknown; readonly url?: unknown }[]
  }
}

/** A stream option for a URL of the mock, as the real ladder labels its rung's format. */
function streamOf(url: string, rung: 'top' | 'fallback', ctx: ProviderContext): StreamOption {
  const common = {
    url,
    protocol: 'progressive',
    ipBound: true,
    expiresAt: Date.now() + URL_LIFETIME_MS,
    // Where bytes are readable the real ladder probes the end of the file; here they never are.
    fullLength: ctx.capabilities.mediaBytes ? 'verified' : 'unverified',
  } as const
  return rung === 'top'
    ? {
        ...common,
        codec: 'opus',
        container: 'webm',
        media: 'audio',
        bitrateKbps: 150,
        tier: 'high',
      }
    : {
        ...common,
        codec: 'aac',
        container: 'mp4',
        media: 'muxed-video',
        bitrateKbps: 96,
        tier: 'normal',
      }
}

/** A YouTube "ladder" with two rungs, each one `/player` call through the platform. */
function youtubeLadder(): StreamSource {
  return {
    id: 'ytm',
    hasFallback: true,
    async resolve(candidate, { ctx, rung, signal }) {
      const response = await ctx.fetch(PLAYER_URL, {
        method: 'POST',
        body: JSON.stringify({ context: { client: CLIENTS[rung] }, videoId: candidate.ref }),
        signal,
      })
      if (!response.ok) throw new FxmError('Network', `The player answered ${response.status}`)
      const answer = (await response.json()) as PlayerAnswer
      if (answer.videoDetails?.videoId !== candidate.ref) {
        throw new FxmError('Parse', 'The player answered for another video')
      }
      if (answer.playabilityStatus?.status !== 'OK') {
        throw new FxmError('Unavailable', 'The video is not playable')
      }
      const formats =
        rung === 'top' ? answer.streamingData?.adaptiveFormats : answer.streamingData?.formats
      return (formats ?? [])
        .map((format) => format.url)
        .filter((url): url is string => typeof url === 'string' && url.startsWith('https://'))
        .map((url) => streamOf(url, rung, ctx))
    },
  }
}

/** Internet Archive: the file on the test network's file host. */
function archiveSource(): StreamSource {
  return {
    id: 'archive',
    async resolve(candidate) {
      const [identifier = '', ...path] = candidate.ref.split('/')
      const file = path.map(encodeURIComponent).join('/')
      return [
        {
          url: `https://${E2E_ARCHIVE_HOST}/download/${encodeURIComponent(identifier)}/${file}`,
          codec: 'pcm',
          container: 'wav',
          media: 'audio',
          tier: 'lossless',
          protocol: 'progressive',
          ipBound: false,
          fullLength: 'unverified',
        },
      ]
    },
  }
}

/** The credits of the Internet Archive track. */
function attribution(track: Track): EmbedAttribution | undefined {
  if (track.source !== 'archive') return undefined
  return {
    provider: 'Internet Archive',
    pageUrl: `https://archive.org/details/${E2E_ARCHIVE_TRACK.identifier}`,
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
  }
}

/** The sources the test doubles load and play (the browser tests' `WIRED_SOURCES`). */
export const E2E_SOURCES: ReadonlySet<string> = new Set(['ytm', 'archive'])

/** The test doubles, on the real platform. */
export function createE2eServices(_platform: EmbedPlatform): EmbedServices {
  const { youtube, archive } = fixtures()
  return {
    catalog: createProviderCatalog([youtube, archive], { attribution }),
    sources: [youtubeLadder(), archiveSource()],
  }
}
