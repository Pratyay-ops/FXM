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
  isAudioCandidate,
  isMatchBand,
  type LadderRung,
  type MatchBand,
  type MatchSignals,
  type MatchTarget,
  type ProviderContext,
  type QualityPrefs,
  type SourceId,
  type StreamFailureFacts,
  type StreamOption,
  type StreamRecovery,
  type Track,
} from '@fxm/core'

/**
 * The request budget's priority a call draws on, in the budget's own words (`RequestPriority`
 * in `@fxm/platform`, 1.2): `current-track` for the track that plays or is about to,
 * `prefetch` for the next ones.
 */
export type ResolvePriority = 'current-track' | 'prefetch'

/** The details of one call to {@link StreamSource.resolve}. */
export interface StreamSourceRequest {
  /**
   * The provider context, carrying {@link StreamSourceRequest.signal}. Its `fetch` draws on the
   * request budget at the priority of the most urgent caller waiting for this resolution, so it
   * rises to `current-track` when the track is played while it is still being prefetched.
   */
  ctx: ProviderContext
  /** The quality preferences: only a hint for ordering options of equal quality. */
  prefs: QualityPrefs
  /**
   * `top`: the whole ladder, best rung first, as `AudioSource.resolve` runs it: the options of
   * the first rung that yields a playable URL, which may be YouTube's itag 18 when the better
   * rungs failed. `fallback`: only the last-resort rung (itag 18), because the top rung's URLs
   * failed their probe. Only asked of a source with {@link StreamSource.hasFallback}.
   */
  rung: LadderRung
  /** The priority the resolution started at; `ctx.fetch` follows a later raise. */
  priority: ResolvePriority
  /** Cancels the resolution. */
  signal: AbortSignal
}

/** What the lifecycle tells a source about a stream whose rung failed. */
export interface StreamFailureReport {
  /** What the lifecycle knew about the failure. */
  facts: StreamFailureFacts
  /** What it decided: always another rung, `fallback` or `top` again. */
  recovery: StreamRecovery
}

/**
 * Resolves the candidates of one audio source into streams: `AudioSource.resolve` plus what
 * the lifecycle needs for its probing rules.
 *
 * **The YouTube ladder (1.4)** resolves `ytm` candidates: VISIONOS, then the muxed itag 18.
 * Where bytes are readable it probes the end of the file and reports `fullLength` `verified` or
 * `capped`; in the Lite tier it returns `unverified` URLs, and the lifecycle uses the media
 * element's first request as the probe. Its adapter takes the ladder's `hasFallback`, answers
 * `rung: 'fallback'` with the ladder's `rungs: 'fallback'` (itag 18 only), says which rung an
 * option came from (`rungOf`) and forwards {@link reportFailure} to `reportPlaybackFailure`.
 * The ladder's `YouTubeUnplayableError` already carries the playability verdict (`UNPLAYABLE`,
 * `ERROR`) that Smart Replace acts on, so it passes through as it is.
 */
export interface StreamSource {
  /** The audio source whose candidates this resolves (`ytm` for every YouTube video). */
  readonly id: SourceId
  /** Whether the source has a fallback rung to ask for (YouTube's itag 18). */
  readonly hasFallback?: boolean
  /**
   * Every stream option for `candidate`, best first, as `AudioSource.resolve` returns them.
   * Rejects with an `FxmError`: one carrying a playability verdict (`unplayableError`, or 1.4's
   * `YouTubeUnplayableError`) for a verdict on the item itself, `BotCheck` after the ladder's
   * bot-check handling gave up, `Unsupported` when the platform cannot reach the source,
   * `NotFound`, `Unavailable` or `GeoBlocked` when the source refuses the item, `Network`,
   * `Parse` or `RateLimited` for passing trouble. A YouTube candidate arrives with the source
   * `ytm`, whichever YouTube prefix named it.
   */
  resolve(candidate: AudioCandidate, request: StreamSourceRequest): Promise<StreamOption[]>
  /**
   * The rung an option came from: `fallback` for YouTube's itag 18 (1.4:
   * `option.rung === 'android-muxed'`), `top` otherwise, `undefined` when the source cannot tell.
   * A `top` resolution runs the whole ladder, so it may return itag 18; the lifecycle's probing
   * rules depend on the rung a failed stream really came from. Default: the rung asked for.
   */
  rungOf?(option: StreamOption): LadderRung | undefined
  /**
   * Called when a stream's rung failed, before the lifecycle resolves on another rung: an
   * `unverified` URL failed its first request (the probe in the Lite tier, or after a CORS
   * failure following a googlevideo redirect), or the rung answered 403 again, so the
   * recovery's reason is `probe-failed`, `fallback-failed` or `forbidden-again`. The YouTube
   * ladder's adapter forwards it to `reportPlaybackFailure(stream, ctx, recovery.reason)`, so
   * the rung cools down and later resolutions of every video try it last for a while.
   */
  reportFailure?(
    stream: StreamOption,
    report: StreamFailureReport,
    request: { ctx: ProviderContext; signal: AbortSignal },
  ): void
  /**
   * A labelled state for an error {@link resolve} rejected with, so "Unavailable" can say why,
   * e.g. 1.4's `unavailableStateOf` (`age-restricted`, `made-for-kids`, `live`, `premiere`).
   * A verdict carries its state itself (`PlayabilityVerdict.state`).
   */
  stateOf?(error: unknown): string | undefined
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
export interface TrackMatchRequest {
  /** What to look for: the song on YouTube Music, or a lossless copy (see `MatchTarget`). */
  target: MatchTarget
  /**
   * The provider context, carrying {@link TrackMatchRequest.signal}. Its `fetch` draws on the
   * request budget at the priority of the most urgent caller waiting for this match.
   */
  ctx: ProviderContext
  /**
   * Candidates known to be gone (Smart Replace found a verdict on them): never return them as
   * the best match or an alternative.
   */
  exclude: readonly AudioCandidate[]
  /** The priority the match started at; `ctx.fetch` follows a later raise. */
  priority: ResolvePriority
  /** Cancels the match. */
  signal: AbortSignal
}

/** What the matching engine decided for a track (1.7's `MatchResult`, as far as playback needs it). */
export interface MatchOutcome {
  /**
   * The best candidate's band with the user's Auto setting applied (`effectiveMatchBand`);
   * `none` when nothing came close.
   */
  band: MatchBand
  /**
   * The best candidate, carrying its `signals` and the engine's `verdict`. Absent when there
   * were none; may be present with `none`, as the closest candidate.
   */
  best?: AudioCandidate
  /** The other candidates, best first: the alternatives behind "Not the right version?". */
  alternatives: readonly AudioCandidate[]
  /** Why, for people: the gate, the band and what blocked Auto. */
  evidence?: readonly string[]
  /**
   * Whether a page the matcher wanted could not be fetched (1.7's `MatchResult.incomplete`):
   * the outcome may play as decided, but the lifecycle does not keep it.
   */
  incomplete?: boolean
}

/**
 * Finds the audio for a track that has none of its own, or the lossless copy of one: the
 * matching engine (1.7) with the searches that feed it (YouTube Music for songs, 1.3; Internet
 * Archive and Jamendo for lossless copies, 1.6; ISRCs from Spotify or MusicBrainz). It decides
 * the band, with the Auto setting applied, and every candidate it returns is playable in
 * `ctx.mode`.
 */
export interface TrackMatcher {
  /** Finds `track`'s match for `request.target`. */
  match(track: Track, request: TrackMatchRequest): Promise<MatchOutcome>
}

/** What a stored decision is filed under: the track, the catalog mode and what was looked for. */
export interface MatchKey {
  /** The track that needed audio, e.g. a Spotify track. */
  sourceTrackId: EntityId<'track'>
  /** The catalog mode the decision was made in. */
  mode: CatalogMode
  /**
   * What was looked for. The `song` decision is the match cache's record for the track and mode
   * (2.6), and a user's pin is filed there, whatever its source. `lossless` decisions are kept
   * under a key of their own (see {@link matchKeyString}), so they never overwrite it.
   */
  target: MatchTarget
}

/**
 * One decision about a track's audio, as the match cache keeps it (2.6's `MatchCacheRecord`
 * without its key fields): the matching engine's, also when nothing came close (`none`), or
 * the user's pin. A Suggest-band guess is stored as `suggest` and never counts as confirmed; a
 * pin always wins and is never deleted by FXM itself.
 */
export interface StoredMatch {
  /** How sure the engine is; for a pin, the band the engine gave that candidate, else `none`. */
  band: MatchBand
  /**
   * The engine's best candidate, or the one the user pinned. Absent when there was none; a
   * `none` decision may keep the closest candidate.
   */
  candidate?: AudioCandidate
  /** The other candidates, best first, for the version switcher. */
  alternatives: readonly AudioCandidate[]
  /** The facts the decision rested on (ISRC, release, album), when the engine computed them. */
  signals?: MatchSignals
  /** Why the decision came out this way, for people. */
  evidence: readonly string[]
  /** Whether the user chose {@link candidate}: their pick in "Not the right version?". */
  userPinned: boolean
  /** When the decision was made, in epoch milliseconds. */
  decidedAt: number
}

/**
 * Where decisions are kept: the match cache in the app's database (2.6), keyed by the source
 * track ID and the catalog mode, kept about 30 days. {@link createMemoryMatchStore} keeps them
 * in memory until that store is wired in.
 */
export interface MatchStore {
  /** The decision filed under `key`, if any. */
  get(key: MatchKey): Promise<StoredMatch | undefined>
  /** Files `match` under `key`, replacing what was there. */
  put(key: MatchKey, match: StoredMatch): Promise<void>
  /**
   * Removes the decision filed under `key`. The lifecycle removes a pin only when the user asks
   * (`unpinMatch`, or choosing the track's own audio).
   */
  delete(key: MatchKey): Promise<void>
}

function isMatchSignals(value: unknown): value is MatchSignals {
  if (typeof value !== 'object' || value === null) return false
  const { isrcVerified, sourceAlbumMatch } = value as Readonly<Record<string, unknown>>
  return typeof isrcVerified === 'boolean' && typeof sourceAlbumMatch === 'boolean'
}

/**
 * A well-formed {@link StoredMatch} from an untrusted value, e.g. one read back from storage or
 * an imported backup, or `undefined` when its band, candidate, pin flag or time is malformed:
 * the lifecycle then decides again. A pin needs a candidate, and so does an `auto` or `suggest`
 * decision. A malformed alternative, evidence line or `signals` is dropped on its own, and
 * unknown fields are never copied.
 */
export function sanitizeStoredMatch(value: unknown): StoredMatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const match = value as Readonly<Record<string, unknown>>
  const { band, userPinned, decidedAt } = match
  const candidate = match.candidate ?? undefined
  if (!isMatchBand(band) || typeof userPinned !== 'boolean') return undefined
  if (typeof decidedAt !== 'number' || !Number.isFinite(decidedAt)) return undefined
  if (candidate !== undefined && !isAudioCandidate(candidate)) return undefined
  if (candidate === undefined && (userPinned || band !== 'none')) return undefined
  const alternatives = Array.isArray(match.alternatives)
    ? match.alternatives.filter(isAudioCandidate)
    : []
  const evidence = Array.isArray(match.evidence)
    ? match.evidence.filter((line): line is string => typeof line === 'string')
    : []
  return {
    band,
    ...(candidate === undefined ? {} : { candidate }),
    alternatives,
    ...(isMatchSignals(match.signals) ? { signals: match.signals } : {}),
    evidence,
    userPinned,
    decidedAt,
  }
}

/**
 * The string a {@link MatchKey} is filed under: the match cache's `<entityKey>|<mode>` (2.6's
 * `matchKey`) for the song decision, and `<entityKey>|<mode>|lossless` for the lossless one.
 * Both YouTube prefixes of a track give the same key.
 */
export function matchKeyString({ sourceTrackId, mode, target }: MatchKey): string {
  const key = `${entityKey(sourceTrackId)}|${mode}`
  return target === 'song' ? key : `${key}|${target}`
}

/** A {@link MatchStore} in memory, plus a way to look inside it for tests and diagnostics. */
export interface MemoryMatchStore extends MatchStore {
  /** How many decisions it holds. */
  readonly size: number
}

/** A {@link MatchStore} that keeps decisions in memory, for tests and until 2.6's is wired in. */
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
