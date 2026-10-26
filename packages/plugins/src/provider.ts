/**
 * A plugin as `@fxm/core` providers: a `MetadataProvider` when it can `search`, an `AudioSource`
 * when it can `resolve`, a `RecommendationProvider` when it has `radio`. Each method runs the
 * matching handler in the plugin's isolated document (`host.ts`) and checks what it returns
 * (`results.ts`); the app uses them like any built-in provider.
 *
 * A plugin's metadata is called only for what the user explicitly asked of it
 * (`requestPolicy: 'explicit'`): a search with the plugin's source picked, or one of its pages.
 * So FXM never sends a plugin the user's other searches, suggestions or background work.
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  type EntityId,
  FxmError,
  filterPlayable,
  isTrackSeed,
  type JsonValue,
  type MatchSourceExtras,
  type MetadataProvider,
  type PageOptions,
  type PluginSourceId,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type RecommendationProvider,
  type SearchType,
  type Track,
} from '@fxm/core'
import type { PluginRunner } from './host'
import { pluginSourceId } from './manifest'
import {
  type ResultContext,
  toAlbum,
  toArtist,
  toCandidates,
  toPlaylist,
  toSearchResults,
  toStreams,
  toSuggestions,
  toTrack,
  toTrackPage,
  toTracks,
} from './results'

/** What a plugin provides to the app. */
export interface PluginProviders {
  /** The plugin's ID. */
  readonly id: string
  /** Its source: `plugin.<id>`. */
  readonly source: PluginSourceId
  /** Its catalog, when it can `search`. */
  readonly metadata?: MetadataProvider
  /** Its audio, when it can `resolve`. */
  readonly audio?: AudioSource
  /** Its radio, when it has `radio`. */
  readonly recommendations?: RecommendationProvider
}

const SEARCH_TYPES: readonly SearchType[] = ['track', 'video', 'album', 'artist', 'playlist']

/** The page size a plugin is asked for: 20 by default, at most 50. */
function pageLimit(limit: number | undefined): number {
  return limit === undefined || !Number.isFinite(limit)
    ? 20
    : Math.min(50, Math.max(1, Math.trunc(limit)))
}

/** A cursor to hand back, as the plugin gave it. */
function cursorOf(options: PageOptions): { cursor?: string } {
  return options.cursor === undefined ? {} : { cursor: options.cursor }
}

/** What a plugin is told about a track: its own ID only when the track is from its source. */
function trackInput(source: PluginSourceId, track: Track): JsonValue {
  const input: Record<string, JsonValue> = {
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
  }
  const parts = parseId(track.id)
  if (track.source === source && parts.source === source) input.id = parts.nativeId
  if (track.album !== undefined) input.album = track.album.name
  if (track.durationMs !== undefined) input.durationMs = track.durationMs
  if (track.isrc !== undefined) input.isrc = track.isrc
  return input
}

/** The candidate for a track of the plugin's own source: no search needed. */
function ownCandidate(source: PluginSourceId, track: Track): AudioCandidate {
  return {
    source,
    ref: parseId(track.id).nativeId,
    kind: track.kind,
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
    ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
    confidence: 1,
    evidence: ['same source'],
  }
}

/** Creates the providers of the plugin `runner` runs. */
export function createPluginProviders(runner: PluginRunner): PluginProviders {
  const { manifest } = runner
  const source = pluginSourceId(manifest.id)
  const provides = new Set(manifest.provides)
  const rc = (ctx: ProviderContext): ResultContext => ({
    source,
    hosts: manifest.hosts,
    name: manifest.name,
    mode: ctx.mode,
  })

  /** The native ID of one of the plugin's own entities. */
  function own<K extends 'track' | 'album' | 'artist' | 'playlist'>(id: EntityId<K>): string {
    const parts = parseId(id)
    if (parts.source !== source) {
      throw new FxmError('NotFound', `${id} is not an entity of ${manifest.name}`)
    }
    return parts.nativeId
  }

  const metadata: MetadataProvider | undefined = provides.has('search')
    ? {
        id: source,
        requestPolicy: 'explicit',
        async search(query, options, ctx) {
          const types = options.types.filter((type) => SEARCH_TYPES.includes(type))
          const value = await runner.run(
            'search',
            [
              query.slice(0, 500),
              { types: [...types], limit: pageLimit(options.limit), ...cursorOf(options) },
            ],
            ctx,
          )
          return toSearchResults(rc(ctx), value, types)
        },
        ...(provides.has('suggest')
          ? {
              async suggest(query: string, ctx: ProviderContext) {
                return toSuggestions(
                  rc(ctx),
                  await runner.run('suggest', [query.slice(0, 500)], ctx),
                )
              },
            }
          : {}),
        async getTrack(id, ctx) {
          return toTrack(rc(ctx), await runner.run('track', [own(id)], ctx))
        },
        async getAlbum(id, ctx) {
          return toAlbum(rc(ctx), await runner.run('album', [own(id)], ctx))
        },
        async getArtist(id, ctx) {
          return toArtist(rc(ctx), await runner.run('artist', [own(id)], ctx))
        },
        async getPlaylist(id, ctx) {
          const value = await runner.run(
            'playlist',
            [own(id), { limit: pageLimit(undefined) }],
            ctx,
          )
          return toPlaylist(rc(ctx), value)
        },
        ...(provides.has('playlist')
          ? {
              async getPlaylistTracks(
                id: EntityId<'playlist'>,
                options: PageOptions,
                ctx: ProviderContext,
              ) {
                const value = await runner.run(
                  'playlist',
                  [own(id), { limit: pageLimit(options.limit), ...cursorOf(options) }],
                  ctx,
                )
                return toTrackPage(rc(ctx), value)
              },
            }
          : {}),
      }
    : undefined

  const audio: AudioSource | undefined = provides.has('resolve')
    ? {
        id: source,
        async match(track: Track & MatchSourceExtras, ctx: ProviderContext) {
          if (track.source === source)
            return filterPlayable([ownCandidate(source, track)], ctx.mode)
          if (!provides.has('match')) return []
          const value = await runner.run('match', [trackInput(source, track)], ctx)
          return toCandidates(rc(ctx), value)
        },
        async resolve(candidate, ctx) {
          if (candidate.source !== source) {
            throw new FxmError(
              'Unsupported',
              `${manifest.name} resolves its own candidates, not ${candidate.source}'s`,
            )
          }
          const input: Record<string, JsonValue> = {
            id: candidate.ref,
            title: candidate.title,
            artists: candidate.artists,
          }
          if (candidate.durationMs !== undefined) input.durationMs = candidate.durationMs
          return toStreams(rc(ctx), await runner.run('resolve', [input], ctx))
        },
      }
    : undefined

  const recommendations: RecommendationProvider | undefined = provides.has('radio')
    ? {
        id: source,
        async radio(seed: RadioSeed, ctx: ProviderContext) {
          let input: JsonValue
          if (isTrackSeed(seed)) {
            input = { type: 'track', ...(trackInput(source, seed) as Record<string, JsonValue>) }
          } else {
            const parts = seed.id === undefined ? undefined : parseId(seed.id)
            input = {
              type: 'artist',
              name: seed.name,
              ...(parts?.source === source ? { id: parts.nativeId } : {}),
            }
          }
          return toTracks(rc(ctx), await runner.run('radio', [input], ctx))
        },
      }
    : undefined

  return {
    id: manifest.id,
    source,
    ...(metadata === undefined ? {} : { metadata }),
    ...(audio === undefined ? {} : { audio }),
    ...(recommendations === undefined ? {} : { recommendations }),
  }
}
