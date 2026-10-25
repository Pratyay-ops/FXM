/**
 * The import job: works through an import's rows from the first one still waiting, matches each
 * one, tells the library what it decided, and saves the progress as it goes, so it can stop at
 * any moment (a pause, a reload, a closed tab) and resume where it left off.
 *
 * It is paced by the shared request budget of stage 1.2, as the platform's job-runner contract
 * asks: before every YouTube request it waits outside any request timeout for the budget's next
 * bulk slot (through bot-check pauses, the 5-second spacing and a used-up hour), and a request
 * the budget turns away meanwhile is simply tried again. Spotify requests are spaced about one
 * second apart, and MusicBrainz requests wait in MusicBrainz's own queue.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  effectiveMatchBand,
  isFxmError,
  type MatchBand,
  type MatchRequest,
  type MatchResponse,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import { type ImportSpotify, PAGE_SPACING_MS, rowFromTrack, sleep } from './load'
import {
  type ImportMusicBrainz,
  lookupOnMusicBrainz,
  lookupOnSpotify,
  MUSICBRAINZ_BATCH,
  wantsLookup,
} from './lookup'
import {
  candidateTrackId,
  MAX_ALTERNATIVES,
  matchRow,
  outcomeOfBand,
  planRow,
  trackOfCandidate,
} from './match'
import { catalogTrackOf, isSpotifyRow, storedRow } from './rows'
import { firstPendingRow, nextPlaylistTrack } from './state'
import type { ImportState, RowLookup, RowResult, StoredRow } from './types'
import type { ImportYouTube } from './youtube'

/** What an import job needs from the app. */
export interface ImportEnvironment {
  /**
   * A provider context for the job's calls, with the `bulk` priority of the request budget and
   * the import's catalog mode. Asked for each call, since capabilities change.
   */
  context(signal: AbortSignal): ProviderContext
  /** Waits until the request budget allows the next bulk call (`budget.whenAvailable('bulk')`). */
  waitForBulkSlot(signal: AbortSignal): Promise<void>
  /** Passes a provider error on to the platform (`platform.report`): bot checks pause bulk work. */
  report(error: unknown): void
  /** YouTube Music and YouTube (see `./youtube`). */
  youtube: ImportYouTube
  /** Spotify, when it is switched on. */
  spotify?: ImportSpotify | undefined
  /** MusicBrainz's exact path. */
  musicBrainz?: ImportMusicBrainz | undefined
  /** The user's Auto setting: whether matches may play without asking at all. */
  autoMatch: boolean
  /** The clock, for tests. */
  now?: () => number
  /** A timer that rejects with the signal's reason when it aborts, for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** A decision the library's match cache already holds for a catalog track. */
export interface CachedMatch {
  /** The band it was stored with. */
  band: MatchBand
  /** The best candidate, carrying the engine's verdict when an engine decided. */
  candidate?: AudioCandidate
  /** The alternatives. */
  alternatives: readonly AudioCandidate[]
  /** Why, for people. */
  evidence: readonly string[]
  /** Whether the user chose the candidate. */
  userPinned: boolean
}

/** The engine's decision for a catalog track, for the library's match cache. */
export interface ImportMatchDecision {
  /** The catalog track that needs audio. */
  sourceTrackId: EntityId<'track'>
  /** The catalog mode the decision was made in. */
  mode: CatalogMode
  /**
   * The band with the user's Auto setting applied, so the cache never confirms a match the
   * setting holds back; the candidate's verdict keeps the band with the setting on.
   */
  band: MatchBand
  /** The ISRC the match used. */
  isrc?: string
  /** The best candidate. */
  candidate?: AudioCandidate
  /** The alternatives, best first. */
  alternatives: AudioCandidate[]
  /** Why, for people. */
  evidence: string[]
}

/** Where an import job puts what it decides: the app's library. */
export interface ImportSink {
  /** Saves the progress. Called after every row that took a request, and every few others. */
  save(state: ImportState): Promise<void>
  /** The match cache's decision for a catalog track in a mode, to reuse instead of searching. */
  cachedMatch?(trackId: EntityId<'track'>, mode: CatalogMode): Promise<CachedMatch | undefined>
  /** Stores the engine's decision for a catalog track. */
  recordMatch(decision: ImportMatchDecision): Promise<void>
  /**
   * Puts `track` into the import's playlist before `before` (the playlist track of the next row
   * that has one), or at the end when it is `null`.
   */
  placeTrack(track: Track, before: EntityId<'track'> | null): Promise<void>
  /** Saves fresher metadata of a track the playlist holds (e.g. Spotify's, with artwork). */
  saveTrack(track: Track): Promise<void>
}

/** What the job is doing, for a progress display. */
export interface ImportRunStatus {
  /** The row being processed. */
  index: number
  /**
   * `loading`: loading the track a row only links to; `looking-up`: asking Spotify or
   * MusicBrainz for an ISRC and a length; `waiting`: waiting for the request budget;
   * `matching`: searching YouTube Music.
   */
  phase: 'loading' | 'looking-up' | 'waiting' | 'matching'
}

/**
 * How a run ended:
 *
 * - `done`: every row has a result
 * - `stopped`: the signal aborted it (a pause or a cancel); the progress is saved
 * - `blocked`: YouTube Music cannot be reached on this platform (no FXM Connect or Lite tier),
 *   or is not available yet; the rows wait, and the job can resume later
 */
export type ImportRunEnd =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'blocked'; message: string }

/** How many rows that took no request may pass between two saves. */
const QUIET_ROWS_PER_SAVE = 25

/** How many times a request is tried again after network failures. */
const MAX_NETWORK_RETRIES = 2

/** How many times a request turned away by the budget or a bot check is tried again. */
const MAX_BUDGET_RETRIES = 50

/** How long Spotify is left alone after it failed, unless it said how long. */
const SPOTIFY_COOL_DOWN_MS = 5 * 60 * 1000

/** The longest wait an import honours from a `Retry-After`, before asking the budget again. */
const MAX_RETRY_WAIT_MS = 60_000

/** A failure of the library itself (storage blocked or full), which stops the run. */
class SinkFailure extends Error {
  constructor(readonly original: unknown) {
    super('The library could not save the import')
  }
}

/** `call`, with its failure marked as the library's. */
async function viaSink<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw new SinkFailure(error)
  }
}

/** Everything a page response lists, for candidates' albums and artwork. */
function remember(response: MatchResponse | null, seen: Map<string, Track>): void {
  if (response === null) return
  if (response.kind === 'isrc-top-card') {
    if (response.card !== null) seen.set(response.card.id, response.card)
  } else if (response.kind !== 'release-facts') {
    for (const track of response.tracks) seen.set(track.id, track)
  }
}

/** A row's result from the match cache's decision. */
function resultFromCache(cached: CachedMatch, autoMatch: boolean): RowResult {
  const verdict = cached.candidate?.verdict
  let band: MatchBand = cached.band
  if (cached.userPinned) band = 'auto'
  else if (verdict !== undefined) band = effectiveMatchBand(verdict, autoMatch)
  const result: RowResult = {
    outcome: cached.candidate === undefined ? 'not-found' : outcomeOfBand(band),
    cached: true,
  }
  if (verdict !== undefined) result.verdict = verdict.band
  if (cached.candidate !== undefined) result.best = cached.candidate
  if (cached.alternatives.length > 0) {
    result.alternatives = cached.alternatives.slice(0, MAX_ALTERNATIVES)
  }
  if (cached.evidence.length > 0) result.evidence = [...cached.evidence]
  if (cached.userPinned && cached.candidate !== undefined) {
    result.review = { action: 'confirmed', ref: cached.candidate.ref, at: 0 }
  }
  return result
}

/** The row with what its loaded track says, keeping when the input added it. */
function rowWithTrack(row: StoredRow, track: Track): StoredRow {
  const loaded = storedRow(rowFromTrack(track))
  return row.addedAt === undefined ? loaded : { ...loaded, addedAt: row.addedAt }
}

/** A row that failed, with a message for people. */
function failed(error: string): RowResult {
  return { outcome: 'failed', error }
}

/** The match-cache decision for a catalog row's result. */
function decisionOf(
  sourceTrackId: EntityId<'track'>,
  mode: CatalogMode,
  result: RowResult,
): ImportMatchDecision {
  let band: MatchBand = 'none'
  if (result.outcome === 'matched') band = 'auto'
  else if (result.outcome === 'review') band = 'suggest'
  const decision: ImportMatchDecision = {
    sourceTrackId,
    mode,
    band,
    alternatives: result.alternatives ?? [],
    evidence: result.evidence ?? [],
  }
  if (result.isrc !== undefined) decision.isrc = result.isrc
  if (result.best !== undefined) decision.candidate = result.best
  return decision
}

/** Options for {@link runImport}. */
export interface RunImportOptions {
  /** Stops the run (pause, cancel); the progress so far is saved. */
  signal: AbortSignal
  /** Hears what the job is doing. */
  onStatus?: (status: ImportRunStatus) => void
}

/**
 * Works through `state`'s waiting rows, in order, updating `state` in place and saving it
 * through `sink` as it goes (see the module documentation). Resolves when every row has a
 * result, when the signal aborts, or when YouTube Music cannot be reached; it rejects only when
 * the library fails (storage blocked or full), with the library's error.
 */
export async function runImport(
  state: ImportState,
  env: ImportEnvironment,
  sink: ImportSink,
  options: RunImportOptions,
): Promise<ImportRunEnd> {
  const { signal, onStatus } = options
  const now = env.now ?? Date.now
  const pause = env.sleep ?? sleep
  const seen = new Map<string, Track>()
  let unsaved = 0
  let lastSpotifyCall = Number.NEGATIVE_INFINITY
  let spotifyOffUntil = 0
  let index = firstPendingRow(state)

  const flush = async () => {
    if (unsaved === 0) return
    unsaved = 0
    await viaSink(() => sink.save(state))
  }

  const spotifyNow = (): ImportSpotify | undefined => {
    const spotify = env.spotify
    if (spotify === undefined || now() < spotifyOffUntil) return undefined
    return spotify.isAvailable(env.context(signal)) ? spotify : undefined
  }

  const spacedForSpotify = async () => {
    const wait = lastSpotifyCall + PAGE_SPACING_MS - now()
    if (wait > 0) await pause(wait, signal)
    lastSpotifyCall = now()
  }

  /**
   * One YouTube request, paced by the budget: waits for a bulk slot, and tries again after the
   * budget turned it away, a bot check (whose pause the budget waits out) or a network failure.
   * `null` when it keeps failing, or fails for another reason. `Unsupported` stops the run.
   */
  const viaYouTube = async <T>(
    call: (ctx: ProviderContext) => Promise<T>,
    phase: ImportRunStatus['phase'] = 'matching',
  ): Promise<T | null> => {
    let networkFailures = 0
    let budgetFailures = 0
    for (;;) {
      onStatus?.({ index, phase: 'waiting' })
      await env.waitForBulkSlot(signal)
      onStatus?.({ index, phase })
      try {
        return await call(env.context(signal))
      } catch (error) {
        if (signal.aborted) throw signal.reason
        env.report(error)
        if (isFxmError(error, 'Unsupported')) throw error
        if (isFxmError(error, 'RateLimited') || isFxmError(error, 'BotCheck')) {
          if (++budgetFailures > MAX_BUDGET_RETRIES) return null
          const retryAfter = isFxmError(error) ? (error.retryAfterMs ?? 0) : 0
          await pause(Math.min(Math.max(retryAfter, 1000), MAX_RETRY_WAIT_MS), signal)
          continue
        }
        if (isFxmError(error, 'Network') && ++networkFailures <= MAX_NETWORK_RETRIES) {
          await pause(2000 * networkFailures, signal)
          continue
        }
        if (isFxmError(error, 'NotFound')) throw error
        return null
      }
    }
  }

  const fetchPage = async (request: MatchRequest): Promise<MatchResponse | null> => {
    try {
      const response = await viaYouTube((ctx) => env.youtube.fetchMatchPage(request, ctx))
      remember(response, seen)
      return response
    } catch (error) {
      // A search finding nothing is an empty page, not a failure.
      if (isFxmError(error, 'NotFound')) return null
      throw error
    }
  }

  /** Loads the catalog track a row only links to, and puts it into the playlist. */
  const loadRow = async (row: StoredRow): Promise<StoredRow | RowResult> => {
    const id = row.trackId as EntityId<'track'>
    onStatus?.({ index, phase: 'loading' })
    let track: Track | null
    try {
      if (isSpotifyRow(row)) {
        const spotify = spotifyNow()
        if (spotify === undefined) {
          return failed('Spotify is off or out of reach, so the song can’t be read')
        }
        await spacedForSpotify()
        track = await spotify.getTrack(id, env.context(signal))
      } else {
        track = await viaYouTube((ctx) => env.youtube.getTrack(id, ctx), 'loading')
      }
    } catch (error) {
      if (signal.aborted || (!isSpotifyRow(row) && isFxmError(error, 'Unsupported'))) throw error
      return failed(
        isFxmError(error, 'NotFound') ? 'That song no longer exists' : 'The song could not be read',
      )
    }
    if (track === null) return failed('The song could not be read')
    const loaded = rowWithTrack(row, track)
    state.rows[index] = loaded
    // Saved with the next save, so a resumed import does not load the track again.
    unsaved++
    const ready = track
    await viaSink(() => sink.saveTrack(ready))
    await viaSink(() => sink.placeTrack(ready, nextPlaylistTrack(state, index)))
    return loaded
  }

  /** Looks up an ISRC and a length for a Spotify row: on Spotify, else through MusicBrainz. */
  const lookUp = async (row: StoredRow): Promise<RowLookup | null> => {
    const known = state.lookups[index]
    if (known !== undefined) return known
    onStatus?.({ index, phase: 'looking-up' })
    const spotify = spotifyNow()
    if (spotify !== undefined) {
      try {
        const found = await lookupOnSpotify(spotify, row, env.context(signal), spacedForSpotify)
        if (found.track !== undefined) {
          const track = found.track
          await viaSink(() => sink.saveTrack(track))
        }
        state.lookups[index] = found.lookup
        return found.lookup
      } catch (error) {
        if (signal.aborted || error instanceof SinkFailure) throw error
        // A track Spotify no longer has says nothing about Spotify; anything else pauses it.
        if (!isFxmError(error, 'NotFound')) {
          const retryAfter = isFxmError(error) ? error.retryAfterMs : undefined
          spotifyOffUntil = now() + (retryAfter ?? SPOTIFY_COOL_DOWN_MS)
        }
      }
    }
    if (env.musicBrainz === undefined) return null
    const batch: { index: number; trackId: EntityId<'track'> }[] = []
    for (let next = index; next < state.rows.length && batch.length < MUSICBRAINZ_BATCH; next++) {
      const candidate = state.rows[next] as StoredRow
      if (state.results[next] !== null || state.lookups[next] !== undefined) continue
      if (!wantsLookup(candidate) || candidate.trackId === undefined) continue
      batch.push({ index: next, trackId: candidate.trackId })
    }
    try {
      const found = await lookupOnMusicBrainz(env.musicBrainz, batch, env.context(signal))
      for (const [at, lookup] of found) state.lookups[at] = lookup
    } catch {
      if (signal.aborted) throw signal.reason
      // MusicBrainz is busy or out of reach: this row goes without, the next batch tries again.
      state.lookups[index] = null
    }
    return state.lookups[index] ?? null
  }

  const processRow = async (): Promise<RowResult> => {
    let row = state.rows[index] as StoredRow
    if (planRow(row, state.mode) === 'load') {
      const loaded = await loadRow(row)
      if ('outcome' in loaded) return loaded
      row = loaded
    }
    const plan = planRow(row, state.mode)
    const catalogId = catalogTrackOf(row) === undefined ? undefined : row.trackId
    const searches = plan === 'match' || plan === 'video-song'
    const cachedMatch = sink.cachedMatch?.bind(sink)
    if (catalogId !== undefined && searches && cachedMatch !== undefined) {
      const cached = await viaSink(() => cachedMatch(catalogId, state.mode))
      if (cached !== undefined) {
        return { ...resultFromCache(cached, env.autoMatch), playlistTrackId: catalogId }
      }
    }
    const lookup = plan === 'match' && wantsLookup(row) ? await lookUp(row) : undefined
    const result = await matchRow({
      row,
      ...(lookup === undefined ? {} : { lookup }),
      mode: state.mode,
      autoMatch: env.autoMatch,
      fetchPage,
      seen,
    })
    if (catalogId !== undefined) {
      result.playlistTrackId = catalogId
      if (searches && !result.incomplete) {
        const decision = decisionOf(catalogId, state.mode, result)
        await viaSink(() => sink.recordMatch(decision))
      }
    } else if (result.outcome === 'matched' && result.best !== undefined) {
      const track =
        seen.get(candidateTrackId(result.best)) ??
        trackOfCandidate(result.best, result.extras?.[result.best.ref])
      result.playlistTrackId = track.id
      state.results[index] = result
      await viaSink(() => sink.placeTrack(track, nextPlaylistTrack(state, index)))
    }
    return result
  }

  try {
    for (; index < state.rows.length; index++) {
      if (state.results[index] !== null) continue
      signal.throwIfAborted()
      let result: RowResult
      try {
        result = await processRow()
      } catch (error) {
        if (signal.aborted || error instanceof SinkFailure || isFxmError(error, 'Unsupported')) {
          throw error
        }
        result = failed('Something went wrong while matching this song')
      }
      state.results[index] = result
      unsaved++
      const quiet = result.outcome === 'ready' || result.cached === true
      if (!quiet || unsaved >= QUIET_ROWS_PER_SAVE) await flush()
    }
    await flush()
    return { status: 'done' }
  } catch (error) {
    if (error instanceof SinkFailure) throw error.original
    await flush().catch((failure: unknown) => {
      throw failure instanceof SinkFailure ? failure.original : failure
    })
    if (signal.aborted) return { status: 'stopped' }
    if (isFxmError(error, 'Unsupported')) return { status: 'blocked', message: error.message }
    throw error
  }
}
