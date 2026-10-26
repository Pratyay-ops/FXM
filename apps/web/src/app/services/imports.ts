/**
 * Imports (stage 3.6) on the app's services: the app's one platform (provider contexts at the
 * request budget's `bulk` priority, the budget's next bulk slot, bot-check reports), YouTube
 * Music and YouTube through `createYouTubeImport` over the providers of stage 1.3, the app's
 * one Spotify provider, which follows the Spotify switch (stage 1.5), the app's MusicBrainz
 * client (stage 1.6) and the user's Auto setting (stage 1.12). `features/import/services.tsx`
 * takes them through `connectAppImportServices`, which `index.ts` calls.
 *
 * Nothing loads before an import needs it: each part is a thin adapter over the composition
 * root's lazy loaders, so opening the Import page still contacts nothing.
 *
 * @module
 */

import { type EntityId, FxmError, parseReleaseDescription, type ReleaseFacts } from '@fxm/core'
import {
  createYouTubeImport,
  type ImportMusicBrainz,
  type ImportSpotify,
  type ImportYouTube,
} from '@fxm/sources/import'
import { createImportServices, type ImportServices } from '../../features/import/services'
import type { AppServices } from './app-services'
import type { Loader } from './lazy-provider'
import type { YouTube } from './youtube'

/**
 * Imports' view of YouTube Music and YouTube: `createYouTubeImport` over the loaded providers,
 * with the engine's top-result cards and the candidates' release facts from 1.3's own calls.
 * YouTube's code loads with the first call.
 */
export function youtubeImport(youtube: Loader<YouTube>): ImportYouTube {
  let built: { readonly youtube: YouTube; readonly adapter: ImportYouTube } | undefined
  async function adapter(): Promise<ImportYouTube> {
    const loaded = await youtube.load()
    if (built?.youtube === loaded) return built.adapter
    const { music, video } = loaded
    const made = createYouTubeImport({
      music,
      video,
      async topResult(query, ctx) {
        const top = await music.topResult(query, ctx)
        return top?.type === 'track' ? top.track : null
      },
      async releaseFacts(trackIds, ctx) {
        const facts: Record<string, ReleaseFacts> = {}
        for (const id of trackIds) {
          const description = await music.getDescription(id as EntityId<'track'>, ctx)
          facts[id] = description === undefined ? {} : parseReleaseDescription(description)
        }
        return facts
      },
    })
    built = { youtube: loaded, adapter: made }
    return made
  }
  return {
    getPlaylist: async (id, ctx) => (await adapter()).getPlaylist(id, ctx),
    getPlaylistTracks: async (id, options, ctx) =>
      (await adapter()).getPlaylistTracks(id, options, ctx),
    getTrack: async (id, ctx) => (await adapter()).getTrack(id, ctx),
    fetchMatchPage: async (request, ctx) => (await adapter()).fetchMatchPage(request, ctx),
  }
}

/**
 * Imports' view of the app's one Spotify provider. Whether it may be used comes from the
 * composition root without downloading Spotify's code: registered here, switched on in
 * Settings and reachable on this tier. The rest loads the provider on first use.
 */
export function spotifyImport(
  app: Pick<AppServices, 'spotify' | 'spotifyAvailable'>,
): ImportSpotify {
  const spotify = () => app.spotify.load()
  return {
    isAvailable: (ctx) => app.spotifyAvailable(ctx),
    getPlaylist: async (id, ctx) => (await spotify()).getPlaylist(id, ctx),
    getPlaylistTracks: async (id, options, ctx) =>
      (await spotify()).getPlaylistTracks(id, options, ctx),
    getAlbum: async (id, ctx) => (await spotify()).getAlbum(id, ctx),
    getTrack: async (id, ctx) => (await spotify()).getTrack(id, ctx),
    getTrackDetails: async (id, ctx) => (await spotify()).getTrackDetails(id, ctx),
  }
}

/** Imports' view of the app's MusicBrainz client, loaded on first use. */
export function musicBrainzImport(app: Pick<AppServices, 'musicBrainz'>): ImportMusicBrainz {
  return {
    lookupUrls: async (urls, ctx, options) =>
      (await app.musicBrainz.load()).lookupUrls(urls, ctx, options),
    getRecordings: async (ids, ctx, options) =>
      (await app.musicBrainz.load()).getRecordings(ids, ctx, options),
  }
}

/**
 * The import services on the app's services, once its platform is ready. Rejects when the
 * platform could not start: imports then say they can't run, rather than wait.
 */
export async function createAppImportServices(app: AppServices): Promise<ImportServices> {
  const platform = await app.start()
  if (platform === undefined) {
    throw new FxmError('Unsupported', 'FXM’s platform could not start, so imports can’t run')
  }
  return createImportServices({
    platform,
    youtube: youtubeImport(app.youtube),
    spotify: spotifyImport(app),
    musicBrainz: musicBrainzImport(app),
    autoMatch: () => app.matchOptions(app.catalogMode()).auto === true,
  })
}
