/**
 * The setup the embed's unit tests share: a controller on the fake platform, with fixture
 * providers, the player's fake engine and fake stream sources shaped like stage 1.4's ladder
 * and stage 1.6's free sources.
 *
 * @module
 */

import {
  type Album,
  type CatalogMode,
  formatId,
  type MetadataProvider,
  type NetworkCapabilities,
  type Playlist,
  type Track,
} from '@fxm/core'
import { createStaticNetworkMonitor, type TrackMatcher } from '@fxm/player'
import { FakeEngine, FakeStreamSource } from '@fxm/player/testing'
import { createProviderCatalog, type EmbedAttribution } from '../catalog'
import { EmbedController } from '../controller'
import { type EmbedTarget, embedTargetOf } from '../target'
import { CAPABILITIES, createFakePlatform } from './fake-platform'
import { FakeMetadataProvider, fixtureTrack } from './fake-provider'

const song = (letter: string): Track =>
  fixtureTrack('ytm', `song${letter}`, {
    title: `Song ${letter}`,
    artists: [{ name: 'The Testers' }],
    durationMs: 200_000,
  })

/** Three YouTube Music songs. */
export const SONG_A = song('A')
export const SONG_B = song('B')
export const SONG_C = song('C')
export const SONGS: readonly Track[] = [SONG_A, SONG_B, SONG_C]

/** An official video without a song link: Music mode can't play it without a matcher. */
export const VIDEO: Track = fixtureTrack('ytm', 'videoA', {
  title: 'Song A (Official Video)',
  kind: 'music-video',
})

/** A plain upload: Music mode hides it. */
export const UPLOAD: Track = fixtureTrack('ytm', 'uploadA', {
  title: 'Song A (Live)',
  kind: 'video',
})

/** An album of the three songs. */
export const ALBUM: Album = {
  id: formatId('ytm', 'album', 'MPREb_album'),
  source: 'ytm',
  name: 'The Album',
  artists: [{ name: 'The Testers' }],
  artwork: [{ url: 'https://i.ytimg.test/album.jpg', width: 226, height: 226 }],
  trackCount: 3,
  tracks: [...SONGS],
}

/** A playlist with a song, the upload and the video. */
export const PLAYLIST: Playlist = {
  id: formatId('ytm', 'playlist', 'PLmixed'),
  source: 'ytm',
  name: 'Mixed Bag',
  owner: { name: 'A Listener' },
  artwork: [],
  trackCount: 40,
  tracks: { items: [SONG_A, UPLOAD, VIDEO], nextCursor: 'page-2' },
}

/** An Internet Archive track. */
export const ARCHIVE_TRACK: Track = fixtureTrack('archive', 'item/side-a.flac', {
  title: 'Side A',
  artists: [{ name: 'Archive Band' }],
})

/** Credits for the Internet Archive track. */
export const ARCHIVE_ATTRIBUTION: EmbedAttribution = {
  provider: 'Internet Archive',
  pageUrl: 'https://archive.org/details/item',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
}

/** The target of a fixture. */
export function targetOf(item: Track | Album | Playlist): EmbedTarget {
  const target = embedTargetOf(item.id)
  if (target === undefined) throw new Error(`No embed for ${item.id}`)
  return target
}

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /** What the address names. */
  readonly target: EmbedTarget
  /** The catalog mode. Default: `music`. */
  readonly mode?: CatalogMode
  /** The tier. Default: Lite. */
  readonly capabilities?: NetworkCapabilities
  /** The providers. Default: YouTube Music and Internet Archive over the fixtures. */
  readonly providers?: readonly MetadataProvider[]
  /** A matching engine. */
  readonly matcher?: TrackMatcher
}

/** A controller on the fake platform, and the fakes behind it. */
export function createHarness(options: HarnessOptions) {
  const platform = createFakePlatform(options.capabilities ?? CAPABILITIES.lite)
  const youtubeProvider = new FakeMetadataProvider('ytm', {
    tracks: [...SONGS, VIDEO, UPLOAD],
    albums: [ALBUM],
    playlists: [PLAYLIST],
  })
  const archiveProvider = new FakeMetadataProvider('archive', { tracks: [ARCHIVE_TRACK] })
  const engine = new FakeEngine()
  const ladder = new FakeStreamSource({ id: 'ytm' })
  const archive = new FakeStreamSource({ id: 'archive' })
  const platformRequests: { youtube: boolean }[] = []
  let servicesCreated = 0
  const controller = new EmbedController({
    target: options.target,
    mode: options.mode ?? 'music',
    async createPlatform(request) {
      platformRequests.push(request)
      return platform
    },
    createServices() {
      servicesCreated += 1
      return {
        catalog: createProviderCatalog(options.providers ?? [youtubeProvider, archiveProvider], {
          attribution: (track) => (track.source === 'archive' ? ARCHIVE_ATTRIBUTION : undefined),
        }),
        sources: [ladder, archive],
        ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
      }
    },
    createEngine: () => engine,
    mediaSession: false,
    network: createStaticNetworkMonitor(),
    player: { retryDelaysMs: [0] },
  })
  return {
    controller,
    platform,
    engine,
    ladder,
    archive,
    youtubeProvider,
    archiveProvider,
    platformRequests,
    servicesCreated: () => servicesCreated,
  }
}

/** Lets pending promises and zero-delay timers run. */
export async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
