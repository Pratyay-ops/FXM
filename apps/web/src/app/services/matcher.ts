/**
 * The matching engine of stage 1.7 with the searches that feed it: the playback policy's
 * `TrackMatcher` (stage 2.3). The engine itself is pure; this module fetches the pages it asks
 * for, through the provider context the lifecycle hands over, whose `fetch` draws on the request
 * budget at the priority of the track being matched.
 *
 * - **Songs** (`target: 'song'`): `runMatch` over YouTube Music, the ISRC gate's songs searches
 *   and top-result card, the text and album searches, two descriptions for the release facts, and
 *   in Music + Video mode the videos searches. A Spotify track first gets its ISRC, label, release
 *   date and album type from Spotify (`details`), or failing that its ISRC from MusicBrainz's
 *   exact path. An official music video in Music mode is matched to its song instead
 *   (`matchVideoToSong`).
 * - **Lossless copies** (`target: 'lossless'`, only with "prefer lossless" on): the Internet
 *   Archive and Jamendo sources' own `match`. Their text-only candidates are suggestions at most;
 *   only an ISRC-verified one plays before the song.
 *
 * A page that can't be fetched (a network error, a bot check, the budget's refusal) is skipped:
 * the outcome is `incomplete`, so the lifecycle plays it but doesn't keep it. Candidates the
 * lifecycle excludes (Smart Replace found them gone) are taken off the pages before the engine
 * ranks them, so its verdict is about the candidates that are left.
 *
 * **Matching options** (stage 1.12): every match runs with `matchingOptions(settings)` from
 * `@fxm/core` (`matchOptions`), so the matching config's thresholds and its measured fallback
 * (`requireReleaseAgreement`) apply, and the Auto band only where the config makes it available
 * and the user's Auto setting is on. The band the lifecycle gets is the best candidate's verdict
 * under that setting (`effectiveMatchBand`), which 2.3's `mayPlayMatch` reads.
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  type CatalogMode,
  candidateKey,
  effectiveMatchBand,
  entityKey,
  type MatchOptions,
  type MatchRequest,
  type MatchResponse,
  type MatchResult,
  type MatchSource,
  type MatchVerdict,
  type MetadataProvider,
  matchingOptions,
  matchVideoToSong,
  modePolicy,
  type ProviderContext,
  parseReleaseDescription,
  type ReleaseFacts,
  type ReleaseFactsKey,
  runMatch,
  type Track,
  videoSongsQuery,
} from '@fxm/core'
import type { MatchOutcome, TrackMatcher, TrackMatchRequest } from '@fxm/player'
import type { IsrcFinding } from '@fxm/sources/musicbrainz'
import type { SpotifyProvider } from '@fxm/sources/spotify'
import type { YouTubeModuleMusic } from '@fxm/sources/youtube/module'

/** The searches the engine's pages come from. */
export interface MatcherSearches {
  /** YouTube Music: songs and videos searches, top-result cards and descriptions. */
  readonly music: Pick<YouTubeModuleMusic, 'search' | 'topResult' | 'getDescription'>
  /** Plain YouTube's search, for Music + Video mode. */
  readonly video: Pick<MetadataProvider, 'search'>
}

/** Options for {@link createTrackMatcher}. */
export interface TrackMatcherOptions {
  /** YouTube Music and YouTube, loaded on first use. */
  readonly youtube: () => Promise<MatcherSearches>
  /** The sources of lossless copies: Internet Archive, and Jamendo where it is set up. */
  readonly lossless: () => Promise<readonly AudioSource[]>
  /**
   * What the engine reads beyond the track, e.g. a Spotify track's ISRC, label, release date and
   * album type. `undefined` when there is nothing to add. Errors are the caller's to handle.
   */
  readonly details?: (
    track: Track,
    request: TrackMatchRequest,
  ) => Promise<Partial<MatchSource> | undefined>
  /**
   * The options a match in `mode` runs with: `matchingOptions({ mode, autoMatch })` with the
   * user's Auto setting. Default: `matchingOptions({ mode })`, Auto off.
   */
  readonly matchOptions?: (mode: CatalogMode) => MatchOptions
  /** Hears every error of a page that was skipped, e.g. `FxmPlatform.report`. */
  readonly report?: (error: unknown) => void
}

/** Whether a track is one of the excluded candidates. */
type Excluded = (track: Track) => boolean

/** Rethrows the caller's cancellation; anything else is a page that could not be fetched. */
function rethrowAbort(ctx: ProviderContext, error: unknown): void {
  const signal = ctx.signal as AbortSignal | undefined
  if (signal?.aborted) throw signal.reason ?? error
}

/** Fetches the page the engine asks for (see `MatchRequest`). */
async function fetchPage(
  request: MatchRequest,
  searches: MatcherSearches,
  ctx: ProviderContext,
  excluded: Excluded,
): Promise<MatchResponse> {
  const keep = (tracks: readonly Track[] | undefined) =>
    (tracks ?? []).filter((track) => !excluded(track))
  switch (request.kind) {
    case 'isrc-songs':
    case 'text-songs':
    case 'album-songs': {
      const results = await searches.music.search(request.query, { types: ['track'] }, ctx)
      return { kind: request.kind, tracks: keep(results.tracks?.items) }
    }
    case 'isrc-top-card': {
      const top = await searches.music.topResult(request.query, ctx)
      const card = top?.type === 'track' && !excluded(top.track) ? top.track : null
      return { kind: 'isrc-top-card', card }
    }
    case 'release-facts': {
      const facts: Record<ReleaseFactsKey, ReleaseFacts> = {}
      for (const id of request.trackIds) {
        const description = await searches.music.getDescription(id, ctx)
        facts[id] = description === undefined ? {} : parseReleaseDescription(description)
      }
      return { kind: 'release-facts', facts }
    }
    case 'videos': {
      const results = await searches.music.search(request.query, { types: ['video'] }, ctx)
      return { kind: 'videos', tracks: keep(results.videos?.items) }
    }
    case 'youtube': {
      const results = await searches.video.search(request.query, { types: ['video'] }, ctx)
      return { kind: 'youtube', tracks: keep(results.videos?.items) }
    }
  }
}

/**
 * The lifecycle's view of the engine's decision. Its band is the best candidate's verdict under
 * the Auto setting the match ran with (`effectiveMatchBand`), which the lifecycle hands to
 * `mayPlayMatch`: a verdict of another matcher version, or none, is a suggestion.
 */
function outcomeOf(
  result: Pick<MatchResult, 'best' | 'candidates' | 'evidence'>,
  incomplete: boolean,
  autoOn: boolean,
): MatchOutcome {
  const { best } = result
  return {
    band: best === undefined ? 'none' : effectiveMatchBand(best.verdict, autoOn),
    ...(best === undefined ? {} : { best }),
    alternatives: result.candidates.filter((candidate) => candidate !== best),
    evidence: result.evidence,
    incomplete,
  }
}

/** Ranks lossless candidates: ISRC-verified first, then by confidence, in a stable order. */
function rankLossless(candidates: readonly AudioCandidate[]): AudioCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        Number(b.candidate.signals?.isrcVerified === true) -
          Number(a.candidate.signals?.isrcVerified === true) ||
        b.candidate.confidence - a.candidate.confidence ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate)
}

/** Where {@link matchDetails} reads a Spotify track's details from. */
export interface MatchDetailsOptions {
  /**
   * Spotify, when it may be asked for this call (switched on, reachable, its secret fetchable
   * here), else `undefined`, so that its code isn't even downloaded.
   */
  readonly spotify: (
    ctx: ProviderContext,
  ) => Promise<Pick<SpotifyProvider, 'isAvailable' | 'getTrackDetails'> | undefined>
  /** MusicBrainz's exact path (`findExactIsrc`): the one recording it links to the track. */
  readonly exactIsrc: (track: Track, request: TrackMatchRequest) => Promise<IsrcFinding | null>
  /** Hears Spotify's errors, e.g. `FxmPlatform.report`. */
  readonly report?: (error: unknown) => void
}

/**
 * The {@link TrackMatcherOptions.details} of a Spotify track (nothing for other sources' tracks):
 *
 * - Spotify's ISRC, label, release date and album type, where Spotify may be asked;
 * - when neither Spotify nor the track has an ISRC, MusicBrainz's exact path, an ISRC-verified
 *   input, merged with what Spotify did say: its label and date still help the engine.
 *
 * A failure of either leaves the match to the track's own fields; only the caller's
 * cancellation is rethrown.
 */
export function matchDetails(
  options: MatchDetailsOptions,
): (track: Track, request: TrackMatchRequest) => Promise<Partial<MatchSource> | undefined> {
  return async (track, request) => {
    if (track.source !== 'spotify') return undefined
    const { ctx } = request
    let found: Partial<MatchSource> | undefined
    try {
      const spotify = await options.spotify(ctx)
      if (spotify?.isAvailable(ctx)) found = await spotify.getTrackDetails(track.id, ctx)
    } catch (error) {
      rethrowAbort(ctx, error)
      options.report?.(error)
    }
    if (track.isrc !== undefined || found?.isrc !== undefined) return found
    let exact: IsrcFinding | null
    try {
      exact = await options.exactIsrc(track, request)
    } catch (error) {
      rethrowAbort(ctx, error)
      return found
    }
    const lengthMs = exact?.recording.lengthMs
    const durationMs = track.durationMs ?? found?.durationMs
    const merged: Partial<MatchSource> = {
      ...found,
      ...(exact?.isrc === undefined ? {} : { isrc: exact.isrc, isrcOrigin: exact.origin }),
      ...(durationMs === undefined && lengthMs !== undefined ? { durationMs: lengthMs } : {}),
    }
    return Object.keys(merged).length === 0 ? undefined : merged
  }
}

/** Creates the app's {@link TrackMatcher}: see the module documentation. */
export function createTrackMatcher(options: TrackMatcherOptions): TrackMatcher {
  const report = options.report ?? (() => {})
  const matchOptions = options.matchOptions ?? ((mode: CatalogMode) => matchingOptions({ mode }))

  async function matchSong(track: Track, request: TrackMatchRequest): Promise<MatchOutcome> {
    const { ctx } = request
    const excludedKeys = new Set(request.exclude.map(candidateKey))
    const excluded: Excluded = (candidate) => excludedKeys.has(entityKey(candidate.id))
    const searches = await options.youtube()
    const settings = matchOptions(ctx.mode)
    const autoOn = settings.auto === true
    let incomplete = false
    const verdict = modePolicy(track, ctx.mode)
    if (verdict === 'needs-song-match' || verdict === 'plays-linked-song') {
      // An official video in Music mode plays as its song. A link it has was tried before the
      // policy asked for a match, so the songs are scored by the rules.
      let songs: Track[] = []
      try {
        const results = await searches.music.search(
          videoSongsQuery(track),
          { types: ['track'] },
          ctx,
        )
        songs = (results.tracks?.items ?? []).filter((song) => !excluded(song))
      } catch (error) {
        rethrowAbort(ctx, error)
        report(error)
        incomplete = true
      }
      const match = matchVideoToSong(track, songs, {
        auto: autoOn,
        ignoreLink: true,
        ...(settings.thresholds === undefined ? {} : { thresholds: settings.thresholds }),
      })
      return outcomeOf(match, incomplete, autoOn)
    }
    const source: MatchSource = { ...track, ...(await options.details?.(track, request)) }
    const result = await runMatch(
      source,
      async (page) => {
        try {
          return await fetchPage(page, searches, ctx, excluded)
        } catch (error) {
          rethrowAbort(ctx, error)
          report(error)
          return null
        }
      },
      { ...settings, mode: ctx.mode },
    )
    return outcomeOf(result, result.incomplete, autoOn)
  }

  async function matchLossless(track: Track, request: TrackMatchRequest): Promise<MatchOutcome> {
    const { ctx } = request
    const excludedKeys = new Set(request.exclude.map(candidateKey))
    const sources = await options.lossless()
    const answers = await Promise.allSettled(sources.map((source) => source.match(track, ctx)))
    let incomplete = false
    const found: AudioCandidate[] = []
    for (const answer of answers) {
      if (answer.status === 'fulfilled') {
        found.push(...answer.value)
        continue
      }
      rethrowAbort(ctx, answer.reason)
      report(answer.reason)
      incomplete = true
    }
    const ranked = rankLossless(
      found.filter((candidate) => !excludedKeys.has(candidateKey(candidate))),
    )
    const [best, ...alternatives] = ranked
    return {
      // Text-only copies are suggestions at most; the policy plays an ISRC-verified one first.
      band: best === undefined ? 'none' : 'suggest',
      ...(best === undefined ? {} : { best }),
      alternatives,
      evidence: best?.evidence ?? [],
      incomplete,
    }
  }

  return {
    match: (track, request) =>
      request.target === 'lossless' ? matchLossless(track, request) : matchSong(track, request),
  }
}

/** A song known by its title and artists, as Home's song candidates name one (stage 3.3). */
export interface SongToFind {
  readonly title: string
  readonly artists: readonly string[]
  readonly durationMs?: number
}

/**
 * The YouTube Music song for a song known by name (a Last.fm station's item, say): the matching
 * engine's best over its own searches, with the matching config's options, as a track of the
 * songs search that listed it, or `null` when nothing matched. Home shows such songs as
 * recommendations: they play as YouTube Music songs, their own audio, never through a match.
 */
export async function findSongTrack(
  song: SongToFind,
  searches: MatcherSearches,
  ctx: ProviderContext,
  options: MatchOptions,
): Promise<Track | null> {
  const seen = new Map<string, Track>()
  const source: MatchSource = {
    title: song.title,
    artists: song.artists.map((name) => ({ name })),
    ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
  }
  const result = await runMatch(
    source,
    async (page) => {
      try {
        const response = await fetchPage(page, searches, ctx, () => false)
        if ('tracks' in response) for (const track of response.tracks) seen.set(track.id, track)
        return response
      } catch (error) {
        rethrowAbort(ctx, error)
        return null
      }
    },
    { ...options, mode: ctx.mode },
  )
  const { best } = result
  if (best === undefined || result.band === 'none' || best.source !== 'ytm') return null
  return seen.get(`ytm:track:${best.ref}`) ?? null
}

/**
 * The song of an official music video (stage 1.7's video-to-song rule over one songs search),
 * for the recommendation collector's `songForVideo` (stage 3.2): a link the video carries, or
 * the rule's match with its verdict, or `null` when it maps to none.
 */
export async function songForVideo(
  video: Track,
  searches: MatcherSearches,
  ctx: ProviderContext,
  options: MatchOptions,
): Promise<{ song: Track; via: 'link' | 'match'; verdict?: MatchVerdict } | null> {
  const results = await searches.music.search(videoSongsQuery(video), { types: ['track'] }, ctx)
  const songs = results.tracks?.items ?? []
  const match = matchVideoToSong(video, songs, {
    auto: options.auto === true,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  })
  const song = songs.find((track) => track.id === match.songId)
  if (match.via === 'none' || song === undefined) return null
  const verdict = match.best?.verdict
  return { song, via: match.via, ...(verdict === undefined ? {} : { verdict }) }
}
