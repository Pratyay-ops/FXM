/**
 * What the stream lifecycle needs from the rest of FXM, as small interfaces. Each one is a
 * touch-point with a stage that may not have merged yet, so the lifecycle and its tests run
 * against fakes (`./testing`) and the real implementations plug in behind the same interface:
 *
 * - {@link StreamSource}: a source's stream resolver. For YouTube that is the resolution
 *   ladder (1.4); for Internet Archive and Jamendo the free sources (1.6), through
 *   {@link fromAudioSource}
 * - {@link TrackMatcher}: the matching engine (1.7) with the searches that feed it
 * - {@link MatchStore}: the match cache (2.6); {@link createMemoryMatchStore} until then
 * - {@link OfflineStore}: downloads (4.1)
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  type CatalogMode,
  type EntityId,
  entityKey,
  isSourceId,
  type LadderRung,
  type MatchTarget,
  type PlaybackBand,
  type ProbePlan,
  type ProviderContext,
  type QualityPrefs,
  type SourceId,
  type StreamOption,
  type Track,
} from '@fxm/core'

/**
 * Which of the request budget's priorities (1.2) a call draws on: the track about to play, or
 * prefetching the next ones.
 */
export type ResolvePriority = 'playback' | 'prefetch'

/** The details of one call to {@link StreamSource.resolve}. */
export interface StreamSourceRequest {
  /** The provider context, carrying {@link StreamSourceRequest.signal}. */
  ctx: ProviderContext
  /** The quality preferences: only a hint for ordering options of equal quality. */
  prefs: QualityPrefs
  /**
   * Which URLs to probe where the bytes are readable (`ctx.capabilities.mediaBytes`): those the
   * source probes by default, or with the data saver on only the one playback would choose
   * (stage 4.3). For a `chosen` scope, probe with `probeChosenStream` from `@fxm/core` and judge
   * the rung by its `outcome`. Absent means `default`; sources that never probe ignore it.
   */
  probe?: ProbePlan
  /**
   * `top`: the whole ladder, best rung first. `fallback`: only the last-resort rung (YouTube's
   * muxed itag 18), because the top rung's URLs failed their probe. Only asked of a source with
   * {@link StreamSource.hasFallback}.
   */
  rung: LadderRung
  /** The budget priority of the calls the resolution makes. */
  priority: ResolvePriority
  /** Cancels the resolution. */
  signal: AbortSignal
}

/**
 * Resolves the candidates of one audio source into streams: `AudioSource.resolve` plus what
 * the lifecycle needs for its probing rules.
 *
 * **The YouTube ladder (1.4)** resolves `ytm` candidates: VISIONOS, then the muxed itag 18.
 * Where bytes are readable it probes the end of the file and reports `fullLength` `verified` or
 * `capped`; in the Lite tier it returns `unverified` URLs, and the lifecycle uses the media
 * element's first request as the probe. When `request.probe` says `chosen` (the data saver), it
 * should probe only the URL playback would choose (`probeChosenStream`; not wired into 1.4 yet).
 * It sets `hasFallback`, honours `rung: 'fallback'` by resolving only itag 18, and reports a
 * playability verdict (`UNPLAYABLE`, `ERROR`) with `unplayableError` from `@fxm/core`, which is
 * what Smart Replace acts on.
 */
export interface StreamSource {
  /** The audio source whose candidates this resolves (`AudioCandidate.source`). */
  readonly id: SourceId
  /** Whether the source has a fallback rung to ask for (YouTube's itag 18). */
  readonly hasFallback?: boolean
  /**
   * Every stream option for `candidate`, best first, as `AudioSource.resolve` returns them.
   * Rejects with an `FxmError`: `unplayableError` for a verdict on the item itself, `BotCheck`
   * after the ladder's bot-check handling gave up, `Unsupported` when the platform cannot reach
   * the source, `Network` or `RateLimited` for passing trouble.
   */
  resolve(candidate: AudioCandidate, request: StreamSourceRequest): Promise<StreamOption[]>
  /**
   * The HTTP status a stream URL answers now, read where the bytes are readable
   * (`ctx.capabilities.mediaBytes`), e.g. with a one-byte ranged GET; `undefined` when it cannot
   * tell. The lifecycle asks after a playback failure, because a 403 on a cached URL means the
   * device's IP address probably changed. Sources whose URLs never fail that way leave it out.
   */
  checkStatus?(
    stream: StreamOption,
    request: { ctx: ProviderContext; signal: AbortSignal },
  ): Promise<number | undefined>
}

/**
 * A {@link StreamSource} for a plain `AudioSource` without a fallback rung, such as Internet
 * Archive's or Jamendo's (1.6). The request's signal travels in the provider context.
 */
export function fromAudioSource(source: AudioSource): StreamSource {
  return {
    id: source.id,
    resolve: (candidate, { ctx, prefs, signal }) =>
      source.resolve(candidate, { ...ctx, signal }, prefs),
  }
}

/** The details of one call to {@link TrackMatcher.match}. */
export interface MatchRequest {
  /** What to look for: the song on YouTube Music, or a lossless copy (see `MatchTarget`). */
  target: MatchTarget
  /** The provider context, carrying {@link MatchRequest.signal}. */
  ctx: ProviderContext
  /**
   * Candidates known to be gone (Smart Replace found a verdict on them): never return them as
   * the best match or an alternative.
   */
  exclude: readonly AudioCandidate[]
  /** The budget priority of the searches the match makes. */
  priority: ResolvePriority
  /** Cancels the match. */
  signal: AbortSignal
}

/** What the matching engine found for a track. */
export interface MatchOutcome {
  /** The best candidate's band; `none` when nothing came close. */
  band: PlaybackBand
  /** The best candidate. Absent when nothing came close. */
  best?: AudioCandidate
  /** The other candidates, best first: the alternatives behind "Not the right version?". */
  alternatives: readonly AudioCandidate[]
}

/**
 * Finds the audio for a track that has none of its own, or the lossless copy of one: the
 * matching engine (1.7) with the searches that feed it (YouTube Music for songs, 1.3; Internet
 * Archive and Jamendo for lossless copies, 1.6; ISRCs from Spotify or MusicBrainz). It decides
 * the band, including whether the Auto band is on at all (1.12), and every candidate it returns
 * is playable in `ctx.mode`.
 */
export interface TrackMatcher {
  /** Finds `track`'s match for `request.target`. */
  match(track: Track, request: MatchRequest): Promise<MatchOutcome>
}

/** What a stored match is filed under: the track, the catalog mode and what was looked for. */
export interface MatchKey {
  /** The track that was matched, e.g. a Spotify track. */
  trackId: EntityId<'track'>
  /** The catalog mode it was matched in. */
  mode: CatalogMode
  /** What was looked for. A user's pin is filed under `song`, whatever its source. */
  target: MatchTarget
}

/**
 * One stored match. A Suggest-band guess is stored as `suggest` and never counts as confirmed;
 * a pin always wins and is never deleted by FXM itself.
 */
export interface StoredMatch {
  /** The band the matching engine gave it. */
  band: Exclude<PlaybackBand, 'none'>
  /** The matched audio. */
  candidate: AudioCandidate
  /** The other candidates, best first. */
  alternatives: readonly AudioCandidate[]
  /** Whether the user pinned it: their pick in "Not the right version?", or a confirmed guess. */
  pinned: boolean
  /** When it was matched or pinned, in epoch milliseconds. */
  matchedAt: number
}

/**
 * Where matches are kept: the match cache in the app's database (2.6), keyed by the source
 * track ID and the catalog mode, kept about 30 days. {@link createMemoryMatchStore} keeps them
 * in memory until that store is wired in.
 */
export interface MatchStore {
  /** The match filed under `key`, if any. */
  get(key: MatchKey): Promise<StoredMatch | undefined>
  /** Files `match` under `key`, replacing what was there. */
  put(key: MatchKey, match: StoredMatch): Promise<void>
  /** Removes the match filed under `key`. The lifecycle never removes a pin. */
  delete(key: MatchKey): Promise<void>
}

/**
 * Whether `value` is a well-formed {@link StoredMatch}, e.g. one read back from storage. The
 * lifecycle ignores a stored match that is not, and matches the track again.
 */
export function isStoredMatch(value: unknown): value is StoredMatch {
  if (typeof value !== 'object' || value === null) return false
  const match = value as Readonly<Record<string, unknown>>
  const candidate = match.candidate as Readonly<Record<string, unknown>> | null | undefined
  return (
    (match.band === 'auto' || match.band === 'suggest') &&
    typeof candidate === 'object' &&
    candidate !== null &&
    isSourceId(candidate.source) &&
    typeof candidate.ref === 'string' &&
    candidate.ref !== '' &&
    typeof candidate.kind === 'string' &&
    Array.isArray(match.alternatives) &&
    typeof match.pinned === 'boolean' &&
    typeof match.matchedAt === 'number' &&
    Number.isFinite(match.matchedAt)
  )
}

/** The string a {@link MatchKey} is filed under: equal for both YouTube prefixes of a track. */
export function matchKeyString({ trackId, mode, target }: MatchKey): string {
  return `${entityKey(trackId)}\u0000${mode}\u0000${target}`
}

/** A {@link MatchStore} in memory, plus a way to look inside it for tests and diagnostics. */
export interface MemoryMatchStore extends MatchStore {
  /** How many matches it holds. */
  readonly size: number
}

/** A {@link MatchStore} that keeps matches in memory, for tests and until 2.6's store is wired in. */
export function createMemoryMatchStore(): MemoryMatchStore {
  const entries = new Map<string, StoredMatch>()
  return {
    get size() {
      return entries.size
    },
    async get(key) {
      return entries.get(matchKeyString(key))
    },
    async put(key, match) {
      entries.set(matchKeyString(key), match)
    },
    async delete(key) {
      entries.delete(matchKeyString(key))
    },
  }
}

/**
 * Offline copies of tracks: downloads (4.1). Local files are a source of their own (`local`,
 * 4.4) and resolve through a {@link StreamSource}.
 */
export interface OfflineStore {
  /**
   * A stream for the offline copy of `track`, e.g. a `blob:` URL of a downloaded file, or
   * `undefined` when there is none. The copy is complete, so its `fullLength` is `verified`.
   */
  find(track: Track, ctx: ProviderContext): Promise<StreamOption | undefined>
}
