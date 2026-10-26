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
 * When the network is out, the run stops with the row it was on still waiting (`blocked`,
 * `offline`), rather than recording what an outage made it miss.
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
  type ReleaseFacts,
  type ReleaseFactsKey,
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
  decisionOf,
  hiddenInMode,
  type ImportMatchDecision,
  MAX_ALTERNATIVES,
  matchRow,
  outcomeOfBand,
  planRow,
  storedResult,
  trackOfCandidate,
} from './match'
import { catalogTrackOf, isSpotifyRow, storedRow } from './rows'
import { firstPendingRow, nextPlaylistTrack } from './state'
import type { ImportBlockReason, ImportState, RowLookup, RowResult, StoredRow } from './types'
import type { ImportYouTube } from './youtube'

export type { ImportMatchDecision } from './match'

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
  /**
   * Whether the device is online (`navigator.onLine`): when it says no, the run stops at once
   * instead of trying requests. Default: always online.
   */
  isOnline?: () => boolean
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

/** Where an import job puts what it decides: the app's library. */
export interface ImportSink {
  /**
   * Saves the progress: at most every {@link SAVE_INTERVAL_MS} while the job runs, and when it
   * ends. A run cut off between two saves repeats those few rows, which only writes what the
   * library holds already.
   */
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
 * - `blocked`: it cannot go on by itself, for `reason` (also saved as `ImportState.blocked`):
 *   YouTube Music cannot be reached on this platform or is not available yet (`unsupported`),
 *   or the network is out (`offline`). The rows wait, and the job can resume later
 */
export type ImportRunEnd =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'blocked'; reason: ImportBlockReason; message: string }

/** The longest a running job goes without saving its progress, in milliseconds. */
export const SAVE_INTERVAL_MS = 20_000

/**
 * How many times a YouTube request is tried again after network failures, waiting 2, 4, 8, 16
 * and 30 seconds, before the run stops as offline: enough to ride out a short drop.
 */
const MAX_NETWORK_RETRIES = 5

/** The longest wait between two network retries, in milliseconds. */
const MAX_NETWORK_WAIT_MS = 30_000

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

/** The network is out: the run stops, and the row it was on waits. */
class OfflineStop extends Error {
  constructor() {
    super('The network is out, so the import paused')
  }
}

/** The answer to a page the source has nothing for (`NotFound`): an empty page of its kind. */
function emptyResponse(request: MatchRequest): MatchResponse {
  if (request.kind === 'isrc-top-card') return { kind: request.kind, card: null }
  if (request.kind === 'release-facts') {
    return { kind: request.kind, facts: {} as Readonly<Record<ReleaseFactsKey, ReleaseFacts>> }
  }
  return { kind: request.kind, tracks: [] }
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

/**
 * A result whose search could not fetch every page and found nothing: it says nothing about
 * the song, so the row counts as failed, and "Retry" tries it again.
 */
function unfinished(result: RowResult): RowResult {
  if (!result.incomplete || result.best !== undefined) return result
  return { ...result, outcome: 'failed', error: 'The search for this song couldn’t be finished' }
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
  const offline = () => env.isOnline?.() === false
  // The tracks the current row's search pages listed, for its candidates' albums and artwork.
  let seen = new Map<string, Track>()
  let unsaved = 0
  let lastSave = now()
  let lastSpotifyCall = Number.NEGATIVE_INFINITY
  let spotifyOffUntil = 0
  let index = firstPendingRow(state)
  if (state.blocked !== undefined) {
    delete state.blocked
    unsaved++
  }

  const flush = async () => {
    if (unsaved === 0) return
    unsaved = 0
    lastSave = now()
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
   * `null` when the budget keeps turning it away, or it fails for another reason. `Unsupported`
   * and `NotFound` are thrown; so is an {@link OfflineStop} when the device is offline or the
   * network keeps failing.
   */
  const viaYouTube = async <T>(
    call: (ctx: ProviderContext) => Promise<T>,
    phase: ImportRunStatus['phase'] = 'matching',
  ): Promise<T | null> => {
    let networkFailures = 0
    let budgetFailures = 0
    for (;;) {
      if (offline()) throw new OfflineStop()
      // The wait may be long (a bot-check pause): what is done so far is saved first, when due.
      if (now() - lastSave >= SAVE_INTERVAL_MS) await flush()
      onStatus?.({ index, phase: 'waiting' })
      await env.waitForBulkSlot(signal)
      onStatus?.({ index, phase })
      try {
        return await call(env.context(signal))
      } catch (error) {
        if (signal.aborted) throw signal.reason
        env.report(error)
        if (isFxmError(error, 'Unsupported') || isFxmError(error, 'NotFound')) throw error
        if (isFxmError(error, 'RateLimited') || isFxmError(error, 'BotCheck')) {
          if (++budgetFailures > MAX_BUDGET_RETRIES) return null
          const retryAfter = isFxmError(error) ? (error.retryAfterMs ?? 0) : 0
          await pause(Math.min(Math.max(retryAfter, 1000), MAX_RETRY_WAIT_MS), signal)
          continue
        }
        if (isFxmError(error, 'Network')) {
          if (++networkFailures > MAX_NETWORK_RETRIES || offline()) throw new OfflineStop()
          await pause(Math.min(2000 * 2 ** (networkFailures - 1), MAX_NETWORK_WAIT_MS), signal)
          continue
        }
        return null
      }
    }
  }

  const fetchPage = async (request: MatchRequest): Promise<MatchResponse | null> => {
    let response: MatchResponse | null
    try {
      response = await viaYouTube((ctx) => env.youtube.fetchMatchPage(request, ctx))
    } catch (error) {
      // A search finding nothing is an empty page, not a failure.
      if (!isFxmError(error, 'NotFound')) throw error
      response = emptyResponse(request)
    }
    remember(response, seen)
    return response
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
      if (signal.aborted || error instanceof OfflineStop || error instanceof SinkFailure) {
        throw error
      }
      if (!isSpotifyRow(row) && isFxmError(error, 'Unsupported')) throw error
      if (offline()) throw new OfflineStop()
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

  /**
   * Looks up an ISRC and a length for a Spotify row: on Spotify, else through MusicBrainz.
   * `undefined` when neither could be asked (MusicBrainz busy or failing), which the row's
   * result marks as incomplete, so "Retry" looks it up again; `null` when nothing was found.
   */
  const lookUp = async (row: StoredRow): Promise<RowLookup | null | undefined> => {
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
        if (offline()) throw new OfflineStop()
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
      unsaved++
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (offline() || isFxmError(error, 'Network')) throw new OfflineStop()
      // MusicBrainz is busy: this row goes without, and the next row's batch asks again.
      return undefined
    }
    return state.lookups[index] ?? null
  }

  const processRow = async (): Promise<RowResult> => {
    seen = new Map()
    let row = state.rows[index] as StoredRow
    if (planRow(row, state.mode) === 'load') {
      const loaded = await loadRow(row)
      if ('outcome' in loaded) return loaded
      row = loaded
    }
    const plan = planRow(row, state.mode)
    const catalogId = catalogTrackOf(row) === undefined ? undefined : row.trackId
    // A row whose own track the mode hides is matched like a row without one.
    const hidden = catalogId !== undefined && hiddenInMode(row, state.mode)
    const ownTrack = hidden ? undefined : catalogId
    const searches = plan === 'match' || plan === 'video-song'
    const cachedMatch = sink.cachedMatch?.bind(sink)
    if (ownTrack !== undefined && searches && cachedMatch !== undefined) {
      const cached = await viaSink(() => cachedMatch(ownTrack, state.mode))
      if (cached !== undefined) {
        return { ...resultFromCache(cached, env.autoMatch), playlistTrackId: ownTrack }
      }
    }
    const lookup = plan === 'match' && wantsLookup(row) ? await lookUp(row) : null
    const result = await matchRow({
      row,
      ...(lookup === undefined ? {} : { lookup }),
      mode: state.mode,
      autoMatch: env.autoMatch,
      fetchPage,
      seen,
    })
    if (lookup === undefined) result.incomplete = true
    if (ownTrack !== undefined) {
      result.playlistTrackId = ownTrack
      if (searches && !result.incomplete) {
        const decision = decisionOf(ownTrack, state.mode, result)
        await viaSink(() => sink.recordMatch(decision))
      }
    } else if (result.outcome === 'matched' && result.best !== undefined) {
      const track =
        seen.get(candidateTrackId(result.best)) ??
        trackOfCandidate(result.best, result.extras?.[result.best.ref])
      result.playlistTrackId = track.id
      state.results[index] = result
      await viaSink(() => sink.placeTrack(track, nextPlaylistTrack(state, index)))
    } else if (hidden) {
      result.playlistTrackId = catalogId as EntityId<'track'>
    }
    return unfinished(result)
  }

  try {
    for (; index < state.rows.length; index++) {
      if (state.results[index] !== null) continue
      signal.throwIfAborted()
      let result: RowResult
      try {
        result = await processRow()
      } catch (error) {
        if (
          signal.aborted ||
          error instanceof SinkFailure ||
          error instanceof OfflineStop ||
          isFxmError(error, 'Unsupported')
        ) {
          // The row stays waiting, also when a placement was written for it already.
          state.results[index] = null
          throw error
        }
        result = failed('Something went wrong while matching this song')
      }
      state.results[index] = storedResult(result)
      unsaved++
      if (now() - lastSave >= SAVE_INTERVAL_MS) await flush()
    }
    await flush()
    return { status: 'done' }
  } catch (error) {
    if (error instanceof SinkFailure) throw error.original
    const reason: ImportBlockReason | undefined = signal.aborted
      ? undefined
      : error instanceof OfflineStop
        ? 'offline'
        : isFxmError(error, 'Unsupported')
          ? 'unsupported'
          : undefined
    if (reason !== undefined) {
      state.blocked = reason
      unsaved++
    }
    await flush().catch((failure: unknown) => {
      throw failure instanceof SinkFailure ? failure.original : failure
    })
    if (signal.aborted) return { status: 'stopped' }
    if (reason !== undefined) {
      return { status: 'blocked', reason, message: (error as Error).message }
    }
    throw error
  }
}
