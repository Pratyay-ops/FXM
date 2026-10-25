/**
 * Runs the app's imports: starts them from a parsed input (playlists, saved albums and artists,
 * listening history), works through them one at a time with the import job of
 * `@fxm/sources/import`, and pauses, resumes, cancels and reviews them. Everything an import
 * decides is in the library (its progress record, its playlist, the match cache), so the page
 * only reads the library; this module adds what only the running tab knows (what the job is
 * doing right now) in a small store.
 *
 * One import runs at a time per tab: the request budget spaces bulk searches anyway. An import
 * left `running` by a closed or reloaded tab shows as interrupted, and resumes where it stopped.
 *
 * @module
 */

import type { CatalogMode, Track } from '@fxm/core'
import {
  applyReview,
  createImportState,
  type ImportCollection,
  type ImportEnvironment,
  type ImportRunStatus,
  type ImportState,
  initialPlaylistTracks,
  isLikelyMatch,
  type ParsedImport,
  type ReviewDecision,
  type ReviewEffect,
  runImport,
  sanitizeImportState,
} from '@fxm/sources/import'
import { create } from 'zustand'
import { getLibrary, LibraryError, type LibraryRepo } from '../../db/repo'
import type { ImportProgressRecord } from '../../db/types'
import type { ImportServices } from './services'
import { createLibrarySink, progressOf } from './sink'

/** The kind of the progress record a listening-history import keeps. */
export const HISTORY_IMPORT_KIND = 'spotify-history'

/** How many plays one library transaction records. */
const PLAYS_PER_BATCH = 500

/** What an import does right now, as only the tab that runs it knows. */
export interface ImportActivity {
  /** What the job does. */
  status?: ImportRunStatus
  /** When the request budget allows the next search, while the job waits for it. */
  waitingUntil?: number
}

interface RunnerState {
  /** The import this tab is running. */
  activeId: string | null
  /** What it does. */
  activity: ImportActivity
  /** The imports waiting in this tab's queue, in order. */
  queued: readonly string[]
}

/** The runner's live state, for the import pages. */
export const useImportRunner = create<RunnerState>()(() => ({
  activeId: null,
  activity: {},
  queued: [],
}))

interface ActiveImport {
  id: string
  state: ImportState
  controller: AbortController
}

/** Why a run was stopped: the abort reasons of a pause and a cancel. */
const PAUSE = 'pause'
const CANCEL = 'cancel'

const queue: string[] = []
let active: ActiveImport | null = null

/** Tells the pages which imports wait in the queue. */
function publishQueue(): void {
  useImportRunner.setState({ queued: [...queue] })
}
const locks = new Map<string, Promise<unknown>>()

/** Runs `body` after every earlier locked call for the same import has finished. */
function withLock<T>(id: string, body: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve()
  const next = previous.then(body, body)
  const settled = next.then(
    () => {},
    () => {},
  )
  locks.set(id, settled)
  void settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id)
  })
  return next
}

/** What the user chose to import from a parsed input. */
export interface ImportChoices {
  /** Which playlists to create, by index in `parsed.collections`. Default: all. */
  collections?: readonly number[]
  /** Their names, by index, when the user changed them. */
  names?: Readonly<Record<number, string>>
  /** Whether to record the listening history. Default: yes. */
  history?: boolean
  /** Whether to follow the saved albums and artists. Default: yes. */
  follows?: boolean
}

/** What {@link startImports} created. */
export interface StartedImports {
  /** The progress records of the playlists, in order. */
  importIds: string[]
  /** The history's progress record, when the history was recorded. */
  historyId?: string
  /** How many albums and artists were followed. */
  followed: number
}

/**
 * Starts importing `parsed` in the catalog `mode`: creates each chosen playlist (with the rows'
 * own catalog tracks) and its progress record, follows the saved albums and artists, and records
 * the listening history. The playlists' matching runs in the background, one import at a time.
 *
 * @throws LibraryError when the library refuses (storage blocked or full).
 */
export async function startImports(
  parsed: ParsedImport,
  choices: ImportChoices,
  mode: CatalogMode,
  services: ImportServices,
): Promise<StartedImports> {
  const repo = getLibrary()
  const started: StartedImports = { importIds: [], followed: 0 }
  // The playlists first, so their matching starts while the rest is saved.
  const chosen = choices.collections ?? parsed.collections.map((_, index) => index)
  for (const index of chosen) {
    const collection = parsed.collections[index]
    if (collection === undefined) continue
    const name = choices.names?.[index]?.trim() || collection.name
    started.importIds.push(await createImport(repo, parsed, { ...collection, name }, mode))
  }
  queue.push(...started.importIds)
  publishQueue()
  void drain(services)
  if (choices.follows !== false) {
    for (const entity of parsed.follows) {
      if (!(await repo.isFollowing(entity.id))) {
        await repo.follow(entity)
        started.followed++
      }
    }
  }
  if (choices.history !== false && parsed.plays.length > 0) {
    started.historyId = await recordHistory(repo, parsed)
  }
  return started
}

/**
 * The tracks a new import's playlist starts with. A track a file only names (by its Spotify
 * URI) keeps the library's own description when it has one, since saving the playlist saves
 * its tracks; a track loaded from a catalog just now is the freshest there is.
 */
async function startingTracks(repo: LibraryRepo, collection: ImportCollection): Promise<Track[]> {
  const loaded = new Set(collection.rows.flatMap((row) => (row.track ? [row.track.id] : [])))
  return Promise.all(
    initialPlaylistTracks(collection).map(async (track) =>
      loaded.has(track.id) ? track : ((await repo.getTrack(track.id)) ?? track),
    ),
  )
}

/** Creates one playlist and its progress record, waiting to run. */
async function createImport(
  repo: LibraryRepo,
  parsed: ParsedImport,
  collection: ImportCollection,
  mode: CatalogMode,
): Promise<string> {
  const playlistId = await repo.createPlaylist({
    name: collection.name,
    tracks: await startingTracks(repo, collection),
    ...(collection.description === undefined ? {} : { description: collection.description }),
  })
  const state = createImportState(parsed.kind, mode, collection)
  const record = await repo.startImport({
    kind: parsed.kind,
    label: collection.name,
    total: state.rows.length,
    playlistId,
  })
  await repo.updateImport(record.id, { status: 'pending', ...progressOf(state) })
  return record.id
}

/**
 * Records a data export's listening history as plays (listening signals), in batches. A play the
 * library already has (the same track at the same start) is not recorded twice, so importing
 * the same export again only fills in what is missing. A track the library already describes
 * keeps that description (with its artwork, say), since recording a play saves its track.
 */
async function recordHistory(repo: LibraryRepo, parsed: ParsedImport): Promise<string> {
  const record = await repo.startImport({
    kind: HISTORY_IMPORT_KIND,
    label: 'Listening history from Spotify',
    total: parsed.plays.length,
  })
  const tracks = new Map<string, Track>()
  let done = 0
  for (let start = 0; start < parsed.plays.length; start += PLAYS_PER_BATCH) {
    const batch = parsed.plays.slice(start, start + PLAYS_PER_BATCH)
    const unknown = [...new Set(batch.map((play) => play.track.id))].filter((id) => !tracks.has(id))
    const cached = await Promise.all(unknown.map((id) => repo.getTrack(id)))
    unknown.forEach((id, index) => {
      const track = cached[index]
      if (track !== undefined) tracks.set(id, track)
    })
    await repo.recordPlays(
      batch.map((play) => ({
        track: tracks.get(play.track.id) ?? play.track,
        playedAt: play.playedAt,
        playedMs: play.playedMs,
        completed: play.completed,
        skipped: play.skipped,
        importId: record.id,
      })),
    )
    done += batch.length
    await repo.updateImport(record.id, { done, matched: done })
  }
  await repo.updateImport(record.id, { status: 'done' })
  return record.id
}

/** What to tell the user when an import stopped for a reason of its own. */
function stopNote(message: string, services: ImportServices): string {
  if (services.capabilities().youtube === 'none') {
    return 'YouTube Music can’t be reached from this browser yet. Add FXM Connect, or use the desktop or Android app, then resume.'
  }
  return message
}

/** The environment of a job over the app's services. */
function environmentOf(services: ImportServices, mode: CatalogMode): ImportEnvironment {
  return {
    context: (signal) => services.context(mode, signal),
    async waitForBulkSlot(signal) {
      const at = services.nextBulkSlotAt()
      if (at > Date.now()) {
        useImportRunner.setState((current) => ({
          activity: { ...current.activity, waitingUntil: at },
        }))
      }
      await services.waitForBulkSlot(signal)
    },
    report: (error) => services.report(error),
    youtube: services.youtube,
    spotify: services.spotify,
    musicBrainz: services.musicBrainz,
    autoMatch: services.autoMatch(),
  }
}

/** Whether a loop is working through the queue, and which reset it belongs to. */
let draining = false
let generation = 0

/** Runs the queued imports, one at a time, until the queue is empty. */
async function drain(services: ImportServices): Promise<void> {
  if (draining) return
  draining = true
  const mine = generation
  try {
    for (let id = queue.shift(); id !== undefined && mine === generation; id = queue.shift()) {
      publishQueue()
      await runOne(id, services)
    }
  } finally {
    if (mine === generation) draining = false
  }
}

async function runOne(id: string, services: ImportServices): Promise<void> {
  // Marked as this tab's from the start, so the page never shows it as interrupted meanwhile.
  useImportRunner.setState({ activeId: id, activity: {} })
  try {
    await runRecord(id, services)
  } finally {
    active = null
    useImportRunner.setState({ activeId: null, activity: {} })
  }
}

async function runRecord(id: string, services: ImportServices): Promise<void> {
  const repo = getLibrary()
  const record = await repo.getImport(id).catch(() => undefined)
  // Only a pending import runs: one paused, cancelled or removed while queued stays as it is.
  if (record === undefined || record.status !== 'pending') return
  const state = sanitizeImportState(record.state)
  if (state === null || record.playlistId === undefined) {
    await repo
      .updateImport(id, {
        status: 'failed',
        error: 'This import’s progress can’t be read, so it can’t go on.',
      })
      .catch(() => {})
    return
  }
  const controller = new AbortController()
  active = { id, state, controller }
  try {
    await repo.updateImport(id, { status: 'running', error: '' })
    const sink = createLibrarySink(repo, id, record.playlistId)
    // Review decisions saved just before the run starts land first.
    await withLock(id, async () => {})
    const end = await runImport(state, environmentOf(services, state.mode), sink, {
      signal: controller.signal,
      onStatus: (status) =>
        useImportRunner.setState((current) => ({
          activity: status.phase === 'waiting' ? { ...current.activity, status } : { status },
        })),
    })
    if (end.status === 'done') await repo.updateImport(id, { status: 'done', error: '' })
    else if (end.status === 'blocked') {
      await repo.updateImport(id, { status: 'paused', error: stopNote(end.message, services) })
    } else {
      const cancelled = controller.signal.reason === CANCEL
      await repo.updateImport(id, { status: cancelled ? 'cancelled' : 'paused', error: '' })
    }
  } catch (error) {
    const message =
      error instanceof LibraryError && error.code === 'not-found'
        ? 'The import’s playlist was deleted, so it stopped.'
        : 'The import stopped: the library could not save it. The browser may be out of space.'
    await repo.updateImport(id, { status: 'failed', error: message }).catch(() => {})
  }
}

/** Resumes a paused or interrupted import: it continues from its first waiting row. */
export async function resumeImport(id: string, services: ImportServices): Promise<void> {
  if (active?.id === id || queue.includes(id)) return
  await getLibrary().updateImport(id, { status: 'pending', error: '' })
  queue.push(id)
  publishQueue()
  void drain(services)
}

/** Pauses an import; its progress is kept. */
export async function pauseImport(id: string): Promise<void> {
  if (active?.id === id) {
    active.controller.abort(PAUSE)
    return
  }
  const queued = queue.indexOf(id)
  if (queued >= 0) queue.splice(queued, 1)
  publishQueue()
  await getLibrary().updateImport(id, { status: 'paused' })
}

/** Cancels an import: it stops for good. Its playlist and what it matched stay. */
export async function cancelImport(id: string): Promise<void> {
  if (active?.id === id) {
    active.controller.abort(CANCEL)
    return
  }
  const queued = queue.indexOf(id)
  if (queued >= 0) queue.splice(queued, 1)
  publishQueue()
  await getLibrary().updateImport(id, { status: 'cancelled' })
}

/** Forgets an import (its progress record). Its playlist and matches stay in the library. */
export async function removeImport(id: string): Promise<void> {
  if (active?.id === id) active.controller.abort(CANCEL)
  const queued = queue.indexOf(id)
  if (queued >= 0) queue.splice(queued, 1)
  publishQueue()
  await getLibrary().deleteImport(id)
}

/** The import's progress: the running job's own when it runs here, else the saved one. */
async function stateOf(
  repo: LibraryRepo,
  id: string,
): Promise<{ state: ImportState; record: ImportProgressRecord }> {
  const record = await repo.getImport(id)
  if (record === undefined) throw new LibraryError('not-found', `No import ${id}`)
  const state = active?.id === id ? active.state : sanitizeImportState(record.state)
  if (state === null) throw new LibraryError('invalid', 'This import’s progress can’t be read')
  return { state, record }
}

/** Does what a review decision asks of the library. */
async function applyEffect(
  repo: LibraryRepo,
  record: ImportProgressRecord,
  state: ImportState,
  effect: ReviewEffect,
): Promise<void> {
  if (effect.type === 'pin') {
    await repo.pinMatch(effect.sourceTrackId, state.mode, effect.candidate)
  } else if (effect.type === 'place' && record.playlistId !== undefined) {
    await createLibrarySink(repo, record.id, record.playlistId).placeTrack(
      effect.track,
      effect.before,
    )
  }
}

/**
 * Applies the user's review decision to row `index` of an import: confirming a candidate pins
 * it as the audio of the row's catalog track, or puts the song into the playlist; skipping
 * leaves the row out.
 */
export function reviewRow(id: string, index: number, decision: ReviewDecision): Promise<void> {
  return withLock(id, async () => {
    const repo = getLibrary()
    const { state, record } = await stateOf(repo, id)
    const effect = applyReview(state, index, decision, Date.now())
    await applyEffect(repo, record, state, effect)
    await repo.updateImport(id, progressOf(state))
  })
}

/**
 * Confirms every likely match of an import (the engine would play it without asking once Auto
 * matching is on). Returns how many it confirmed.
 */
export function confirmLikelyMatches(id: string): Promise<number> {
  return withLock(id, async () => {
    const repo = getLibrary()
    const { state, record } = await stateOf(repo, id)
    let confirmed = 0
    for (const [index, result] of state.results.entries()) {
      if (!isLikelyMatch(result) || result?.best === undefined) continue
      const effect = applyReview(
        state,
        index,
        { action: 'confirm', ref: result.best.ref },
        Date.now(),
      )
      await applyEffect(repo, record, state, effect)
      confirmed++
    }
    if (confirmed > 0) await repo.updateImport(id, progressOf(state))
    return confirmed
  })
}

/** The saved progress of an import, for its page. */
export async function loadImportState(id: string): Promise<ImportState | null> {
  if (active?.id === id) return active.state
  const record = await getLibrary().getImport(id)
  return record === undefined ? null : sanitizeImportState(record.state)
}

/** Tests only: forgets the queue and stops the running import. */
export function resetImportRunner(): void {
  active?.controller.abort(CANCEL)
  active = null
  queue.length = 0
  locks.clear()
  generation++
  draining = false
  useImportRunner.setState({ activeId: null, activity: {}, queued: [] })
}
