/**
 * Where an embed's metadata comes from: the title, the artwork and the tracks of what it shows.
 * The catalog reads `@fxm/core`'s {@link MetadataProvider}s, so the real providers plug in as
 * they are: YouTube Music and YouTube (stage 1.3), Internet Archive and Jamendo (stage 1.6).
 *
 * @module
 */

import {
  type AlbumType,
  type ArtistRef,
  type Artwork,
  FxmError,
  type MetadataProvider,
  type ProviderContext,
  parseId,
  type SourceId,
  type Track,
} from '@fxm/core'
import type { EmbedTarget } from './target'

/** What an embed shows, loaded. */
export interface EmbedEntity {
  /** What the address named. */
  readonly target: EmbedTarget
  /** The track's title, or the album's or playlist's name. */
  readonly title: string
  /** The credited artists: the track's or the album's. Empty for a playlist. */
  readonly artists: readonly ArtistRef[]
  /** For a playlist: who made it, when the source says. */
  readonly owner?: string
  /** For an album: single, EP, album or compilation, when the source says. */
  readonly albumType?: AlbumType
  /** Cover art in the sizes the source offers. May be empty. */
  readonly artwork: readonly Artwork[]
  /**
   * The tracks, in order: the track itself, the album's tracks, or the first page of the
   * playlist's tracks. Not yet filtered for the catalog mode.
   */
  readonly tracks: readonly Track[]
  /** How many tracks the source lists in all; a long playlist has more than its first page. */
  readonly trackCount: number
}

/** What crediting a free-source track takes: who provides it, its page and its licence. */
export interface EmbedAttribution {
  /** Who to credit as the source, e.g. `Internet Archive` or `Jamendo`. */
  readonly provider: string
  /** The track's page at the source. */
  readonly pageUrl: string
  /** The licence's URL, e.g. a Creative Commons deed, when the source states one. */
  readonly licenseUrl?: string
}

/** Loads what an embed shows. */
export interface EmbedCatalog {
  /** Whether a provider for `source` is wired in. */
  supports(source: SourceId): boolean
  /**
   * Loads `target`. Rejects with an `FxmError`: `NotFound` when it doesn't exist, `Unsupported`
   * when no provider for its source is wired in or the tier can't reach it, `BotCheck`,
   * `RateLimited` or `Network` for passing trouble.
   */
  load(target: EmbedTarget, ctx: ProviderContext): Promise<EmbedEntity>
  /**
   * The credits a free-source track needs where it plays (Creative Commons licences and
   * Jamendo's terms ask for them), or `undefined` for a source that needs none.
   */
  attribution?(track: Track): EmbedAttribution | undefined
}

/** Options for {@link createProviderCatalog}. */
export interface ProviderCatalogOptions {
  /** Credits for free-source tracks, e.g. from the Internet Archive and Jamendo sources (1.6). */
  attribution?: (track: Track) => EmbedAttribution | undefined
}

/**
 * A catalog over metadata providers, one per source. A target whose source has no provider
 * rejects with an `Unsupported` `FxmError`, as does a provider's own refusal.
 */
export function createProviderCatalog(
  providers: readonly MetadataProvider[],
  options: ProviderCatalogOptions = {},
): EmbedCatalog {
  const bySource = new Map<SourceId, MetadataProvider>()
  for (const provider of providers) {
    if (!bySource.has(provider.id)) bySource.set(provider.id, provider)
  }
  const { attribution } = options
  return {
    supports: (source) => bySource.has(source),
    async load(target, ctx) {
      const { source } = parseId(target.id)
      const provider = bySource.get(source)
      if (provider === undefined) {
        throw new FxmError('Unsupported', `The embed has no metadata provider for ${source} yet`)
      }
      switch (target.kind) {
        case 'track': {
          const track = await provider.getTrack(target.id, ctx)
          return {
            target,
            title: track.title,
            artists: track.artists,
            artwork: track.artwork,
            tracks: [track],
            trackCount: 1,
          }
        }
        case 'album': {
          const album = await provider.getAlbum(target.id, ctx)
          const tracks = album.tracks ?? []
          return {
            target,
            title: album.name,
            artists: album.artists,
            artwork: album.artwork,
            ...(album.type === undefined ? {} : { albumType: album.type }),
            tracks,
            trackCount: Math.max(album.trackCount ?? 0, tracks.length),
          }
        }
        case 'playlist': {
          const playlist = await provider.getPlaylist(target.id, ctx)
          const tracks = playlist.tracks?.items ?? []
          return {
            target,
            title: playlist.name,
            artists: [],
            ...(playlist.owner === undefined ? {} : { owner: playlist.owner.name }),
            artwork: playlist.artwork,
            tracks,
            trackCount: Math.max(playlist.trackCount ?? playlist.tracks?.total ?? 0, tracks.length),
          }
        }
      }
    },
    ...(attribution === undefined ? {} : { attribution }),
  }
}
