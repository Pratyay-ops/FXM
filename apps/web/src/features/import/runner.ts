/**
 * Runs the app's imports: starts them from a parsed input (playlists, saved albums and artists,
 * listening history), works through them one at a time with the import job of
 * `@fxm/sources/import`, and pauses, resumes, cancels and reviews them. Everything an import
 * decides is in the library (its progress record, its playlist, the match cache), so the page
 * only reads the library; this module adds what only the running tab knows (what the job is
 * doing right now) in a small store.
 *
 * One import runs at a time per tab: the request budget spaces bulk searches anyway. A tab holds
 * an import's Web Lock while it runs it (`./locks`), so no other tab runs it too; those tabs show
 * it as running elsewhere. An import left `running` by a closed or reloaded tab shows as
 * interrupted, and resumes where it stopped.
 *
 * @module
 */

import type { CatalogMode, Track } from '@fxm/core'
import {
  createImportState,
  type ImportCollection,
  type ImportEnvironment,
  type ImportRunStatus,
  type ImportState,
  importBlockOf,
  initialPlaylistTracks,
  isLikelyMatch,
  type ParsedImport,
  planReopen,
  planReview,
  type ReopenEffect,
  type ReviewDecision,
  type ReviewEffect,
  retryFailedRows,
  runImport,
  sanitizeImportState,
} from '@fxm/sources/import'
import { create } from 'zustand'
import { getLibrary, LibraryError, type LibraryRepo } from '../../db/repo'
import type { ImportProgressRecord } from '../../db/types'
import { ImportBusyError, importsHeldElsewhere, resetImportLocks, withImportLock } from './locks'
import type { ImportServices } from './services'
import { createLibrarySink, placeTrack, progressOf, recordDecision } from './sink'

/** The kind of the progress record a listening-history import keeps. */
export const HISTORY_IMPORT_KIND = 'spotify-history'

/** How many plays one library transaction records. */
const PLAYS_PER_BATCH = 500

/** Why an import cannot go on, for people. */
const UNREADABLE = 'This import’s progress can’t be read, so it can’t go on.'
const PLAYLIST_GONE = 'The import’s playlist was deleted, so it stopped.'
const LIBRARY_FULL =
  'The library couldn’t save the import. The browser may be out of space: free some up, then resume.'

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
  /** The listening-history imports this tab is recording now. */
  recording: readonly string[]
}

/** The runner's live state, for the import pages. */
export const useImportRunner = create<RunnerState>()(() => ({
  activeId: null,
  activity: {},
  queued: [],
  recording: [],
}))

interface ActiveImport {
  id: string
  /** Its progress, once the run has read it. */
  state: ImportState | null
  controller: AbortController
  /** Settles once the run has stopped and saved where it stands. */
  finished: Promise<void>
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

function publishRecording(id: string, recording: boolean): void {
  useImportRunner.setState((current) => ({
    recording: recording
      ? [...current.recording, id]
      : current.recording.filter((other) => other !== id),
  }))
}

const locks = new Map<string, Promise<unknown>>()

/** Runs `body` after every earlier locked call for the same import in this tab has finished. */
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

/** Takes an import out of this tab's queue. */
function dequeue(id: string): void {
  const queued = queue.indexOf(id)
  if (queued >= 0) queue.splice(queued, 1)
  publishQueue()
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
  /** What could not be saved while the playlists started: the follows, the history. */
  failed: ('follows' | 'history')[]
}

/**
 * Thrown by {@link startImports} when a playlist could not be created. The playlists created
 * before it are importing (`started`, and their indices in `created`): start the rest again.
 */
export class StartImportsError extends Error {
  override readonly name = 'StartImportsError'

  constructor(
    readonly started: StartedImports,
    readonly created: readonly number[],
    readonly reason: unknown,
  ) {
    super('Some playlists could not be created')
  }
}

/**
 * Starts importing `parsed` in the catalog `mode`: creates each chosen playlist (with the rows'
 * own catalog tracks) and its progress record, follows the saved albums and artists, and records
 * the listening history. The playlists' matching runs in the background, one import at a time.
 * Once the playlists exist, a failure to follow or to record the history is reported in
 * `failed` instead of thrown, so nothing is started twice.
 *
 * @throws StartImportsError when a playlist could not be created (storage blocked or full).
 */
export async function startImports(
  parsed: ParsedImport,
  choices: ImportChoices,
  mode: CatalogMode,
  services: ImportServices,
): Promise<StartedImports> {
  const repo = getLibrary()
  const started: StartedImports = { importIds: [], followed: 0, failed: [] }
  const created: number[] = []
  const enqueue = () => {
    queue.push(...started.importIds)
    publishQueue()
    void drain(services)
  }
  // The playlists first, so their matching starts while the rest is saved.
  try {
    for (const index of choices.collections ?? parsed.collections.map((_, at) => at)) {
      const collection = parsed.collections[index]
      if (collection === undefined) continue
      const name = choices.names?.[index]?.trim() || collection.name
      started.importIds.push(await createImport(repo, parsed, { ...collection, name }, mode))
      created.push(index)
    }
  } catch (error) {
    enqueue()
    throw new StartImportsError(started, created, error)
  }
  enqueue()
  if (choices.follows !== false && parsed.follows.length > 0) {
    try {
      for (const entity of parsed.follows) {
        if (!(await repo.isFollowing(entity.id))) {
          await repo.follow(entity)
          started.followed++
        }
      }
    } catch {
      started.failed.push('follows')
    }
  }
  if (choices.history !== false && parsed.plays.length > 0) {
    try {
      started.historyId = await recordHistory(repo, parsed)
    } catch {
      started.failed.push('history')
    }
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
 * Records a data export's listening history as plays (listening signals), in batches, holding
 * the history's lock so other tabs show it as recording. A play the library already has (the
 * same track at the same start) is not recorded twice, so importing the same export again only
 * fills in what is missing. A track the library already describes keeps that description (with
 * its artwork, say), since recording a play saves its track.
 */
async function recordHistory(repo: LibraryRepo, parsed: ParsedImport): Promise<string> {
  const record = await repo.startImport({
    kind: HISTORY_IMPORT_KIND,
    label: 'Listening history from Spotify',
    total: parsed.plays.length,
  })
  publishRecording(record.id, true)
  try {
    await withImportLock(record.id, async () => {
      const tracks = new Map<string, Track>()
      let done = 0
      for (let start = 0; start < parsed.plays.length; start += PLAYS_PER_BATCH) {
        const batch = parsed.plays.slice(start, start + PLAYS_PER_BATCH)
        const unknown = [...new Set(batch.map((play) => play.track.id))].filter(
          (id) => !tracks.has(id),
        )
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
    })
  } catch (error) {
    await repo.updateImport(record.id, { status: 'failed' }).catch(() => {})
    throw error
  } finally {
    publishRecording(record.id, false)
  }
  return record.id
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
    ...(services.matchingConfig === undefined ? {} : { matchingConfig: services.matchingConfig }),
    isOnline: () => services.isOnline(),
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
  // This tab's from the start, before anything waits: a Pause or Cancel meanwhile reaches the
  // controller, and the page never shows the import as interrupted.
  let finish: () => void = () => {}
  const job: ActiveImport = {
    id,
    state: null,
    controller: new AbortController(),
    finished: new Promise<void>((resolve) => {
      finish = resolve
    }),
  }
  active = job
  useImportRunner.setState({ activeId: id, activity: {} })
  try {
    await withImportLock(id, () => runRecord(job, services))
  } catch {
    // Another tab runs it (ImportBusyError): that tab goes on with it.
  } finally {
    if (active === job) active = null
    useImportRunner.setState({ activeId: null, activity: {} })
    finish()
  }
}

async function runRecord(job: ActiveImport, services: ImportServices): Promise<void> {
  const repo = getLibrary()
  const { id, controller } = job
  try {
    // Read the progress after every review decision already on its way in this tab.
    const start = await withLock(id, async () => {
      const record = await repo.getImport(id).catch(() => undefined)
      // Only a pending import runs: one paused, cancelled or removed while queued stays as it is.
      if (record === undefined || record.status !== 'pending') return null
      if (controller.signal.aborted) {
        const status = controller.signal.reason === CANCEL ? 'cancelled' : 'paused'
        await repo.updateImport(id, { status })
        return null
      }
      const state = sanitizeImportState(record.state)
      if (state === null || record.playlistId === undefined) {
        await repo.updateImport(id, { status: 'failed', error: UNREADABLE })
        return null
      }
      job.state = state
      await repo.updateImport(id, { status: 'running', error: '' })
      return { state, playlistId: record.playlistId }
    })
    if (start === null) return
    const sink = createLibrarySink(repo, id, start.playlistId)
    const end = await runImport(start.state, environmentOf(services, start.state.mode), sink, {
      signal: controller.signal,
      onStatus: (status) =>
        useImportRunner.setState((current) => ({
          activity: status.phase === 'waiting' ? { ...current.activity, status } : { status },
        })),
    })
    if (end.status === 'done') {
      await repo.updateImport(id, { status: 'done', error: '' })
    } else if (end.status === 'blocked') {
      // Why is saved in the progress (`blocked`), for the page to say in its own words.
      await repo.updateImport(id, { status: 'paused', error: '' })
      if (end.reason === 'offline') listenForConnection(services)
    } else {
      const cancelled = controller.signal.reason === CANCEL
      await repo.updateImport(id, { status: cancelled ? 'cancelled' : 'paused', error: '' })
    }
  } catch (error) {
    // A deleted playlist ends the import; anything else the library refused (storage full or
    // blocked) only pauses it, with nothing lost.
    const gone = error instanceof LibraryError && error.code === 'not-found'
    const patch = gone
      ? ({ status: 'failed', error: PLAYLIST_GONE } as const)
      : ({ status: 'paused', error: LIBRARY_FULL } as const)
    await repo.updateImport(id, patch).catch(() => {})
  }
}

/** Puts an import in this tab's queue, unless it runs or waits here already. */
async function enqueueSaved(id: string, services: ImportServices): Promise<void> {
  if (active?.id === id || queue.includes(id)) return
  await getLibrary().updateImport(id, { status: 'pending', error: '' })
  queue.push(id)
  publishQueue()
  void drain(services)
}

/**
 * Resumes a paused or interrupted import: it continues from its first waiting row.
 *
 * @throws ImportBusyError while another tab runs it.
 */
export async function resumeImport(id: string, services: ImportServices): Promise<void> {
  if (active?.id === id || queue.includes(id)) return
  if ((await importsHeldElsewhere()).has(id)) throw new ImportBusyError()
  await enqueueSaved(id, services)
}

let watching: ImportServices | null = null
let listening = false

/** Resumes the imports that paused because the network was out on every `online` event. */
function listenForConnection(services: ImportServices): void {
  watching = services
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('online', () => {
    if (watching !== null) void resumeOffline(watching)
  })
}

/**
 * Resumes the imports that paused because the network was out: now, when the device is online,
 * and on every `online` event from then on. The import pages call it once they have services.
 */
export function watchConnection(services: ImportServices): void {
  listenForConnection(services)
  if (services.isOnline()) void resumeOffline(services)
}

async function resumeOffline(services: ImportServices): Promise<void> {
  const records = await getLibrary()
    .listImports()
    .catch(() => [])
  for (const record of records) {
    if (record.status !== 'paused' || importBlockOf(record.state) !== 'offline') continue
    await resumeImport(record.id, services).catch(() => {})
  }
}

/**
 * Tries an import's failed songs again (and those whose search was cut short): they go back in
 * its queue, and the import resumes. Returns how many. Nothing happens while the import runs in
 * this tab.
 *
 * @throws ImportBusyError while another tab runs it.
 */
export function retryFailedSongs(id: string, services: ImportServices): Promise<number> {
  return withLock(id, async () => {
    if (active?.id === id) return 0
    const count = await withImportLock(id, async () => {
      const repo = getLibrary()
      const state = savedState(await requireRecord(repo, id))
      const retried = retryFailedRows(state)
      if (retried > 0) {
        await repo.updateImport(id, { ...progressOf(state), status: 'pending', error: '' })
      }
      return retried
    })
    if (count > 0 && !queue.includes(id)) {
      queue.push(id)
      publishQueue()
      void drain(services)
    }
    return count
  })
}

/** Pauses an import; its progress is kept. Resolves once it has stopped. */
export async function pauseImport(id: string): Promise<void> {
  if (active?.id === id) {
    const job = active
    job.controller.abort(PAUSE)
    await job.finished
    return
  }
  dequeue(id)
  await getLibrary().updateImport(id, { status: 'paused' })
}

/**
 * Cancels an import: it stops for good. Its playlist and what it matched stay. Resolves once it
 * has stopped, so the playlist can be deleted after it.
 */
export async function cancelImport(id: string): Promise<void> {
  if (active?.id === id) {
    const job = active
    job.controller.abort(CANCEL)
    await job.finished
    return
  }
  dequeue(id)
  await getLibrary().updateImport(id, { status: 'cancelled' })
}

/** Forgets an import (its progress record). Its playlist and matches stay in the library. */
export async function removeImport(id: string): Promise<void> {
  if (active?.id === id) {
    const job = active
    job.controller.abort(CANCEL)
    await job.finished
  }
  dequeue(id)
  await getLibrary().deleteImport(id)
}

async function requireRecord(repo: LibraryRepo, id: string): Promise<ImportProgressRecord> {
  const record = await repo.getImport(id)
  if (record === undefined) throw new LibraryError('not-found', 'This import no longer exists.')
  return record
}

function savedState(record: ImportProgressRecord): ImportState {
  const state = sanitizeImportState(record.state)
  if (state === null) throw new LibraryError('invalid', UNREADABLE)
  return state
}

/**
 * Runs a change to import `id`'s progress, one after another per import: on the running job's
 * own state when this tab runs it (its next save keeps the change), else on the saved progress,
 * under the import's Web Lock so no other tab writes it meanwhile.
 *
 * @throws ImportBusyError while another tab runs the import.
 */
function changeProgress<T>(
  id: string,
  change: (repo: LibraryRepo, state: ImportState, record: ImportProgressRecord) => Promise<T>,
): Promise<T> {
  return withLock(id, async () => {
    const repo = getLibrary()
    if (active?.id === id) {
      // Before the run has read its progress, it reads it after this change (the same lock).
      const record = await requireRecord(repo, id)
      return change(repo, active?.state ?? savedState(record), record)
    }
    return withImportLock(id, async () => {
      const record = await requireRecord(repo, id)
      return change(repo, savedState(record), record)
    })
  })
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
    await placeTrack(repo, record.playlistId, effect.track, effect.before)
  }
}

/** Does what taking a decision back asks of the library. */
async function applyReopen(
  repo: LibraryRepo,
  record: ImportProgressRecord,
  state: ImportState,
  effect: ReopenEffect,
): Promise<void> {
  if (effect.type === 'unpin') {
    await repo.unpinMatch(effect.sourceTrackId, state.mode)
    if (effect.decision !== undefined) await recordDecision(repo, effect.decision)
  } else if (effect.type === 'unplace' && record.playlistId !== undefined) {
    await repo.removeTracks(record.playlistId, [effect.trackId])
  }
}

/**
 * Applies the user's review decision to row `index` of an import: confirming a candidate pins
 * it as the audio of the row's catalog track, or puts the song into the playlist; skipping
 * leaves the row out. The row changes only once the library has done its part.
 *
 * @throws ImportBusyError while another tab runs the import.
 */
export function reviewRow(id: string, index: number, decision: ReviewDecision): Promise<void> {
  return changeProgress(id, async (repo, state, record) => {
    const planned = planReview(state, index, decision, Date.now())
    await applyEffect(repo, record, state, planned.effect)
    state.results[index] = planned.result
    await repo.updateImport(id, progressOf(state))
  })
}

/**
 * Confirms every likely match of an import (the engine would play it without asking once Auto
 * matching is on). Returns the rows it confirmed, for an Undo.
 *
 * @throws ImportBusyError while another tab runs the import.
 */
export function confirmLikelyMatches(id: string): Promise<number[]> {
  return changeProgress(id, async (repo, state, record) => {
    const confirmed: number[] = []
    try {
      for (const [index, result] of state.results.entries()) {
        if (!isLikelyMatch(result) || result?.best === undefined) continue
        const decision = { action: 'confirm', ref: result.best.ref } as const
        const planned = planReview(state, index, decision, Date.now())
        await applyEffect(repo, record, state, planned.effect)
        state.results[index] = planned.result
        confirmed.push(index)
      }
    } finally {
      if (confirmed.length > 0) await repo.updateImport(id, progressOf(state))
    }
    return confirmed
  })
}

/**
 * Takes the user's decisions about these rows back: each waits for review again, with its pin
 * removed (the engine's own decision cached again) or its placed song taken out of the
 * playlist. Returns how many it reopened.
 *
 * @throws ImportBusyError while another tab runs the import.
 */
export function reopenRows(id: string, indices: readonly number[]): Promise<number> {
  return changeProgress(id, async (repo, state, record) => {
    let reopened = 0
    try {
      for (const index of indices) {
        if (state.results[index]?.review === undefined) continue
        const planned = planReopen(state, index)
        await applyReopen(repo, record, state, planned.effect)
        state.results[index] = planned.result
        reopened++
      }
    } finally {
      if (reopened > 0) await repo.updateImport(id, progressOf(state))
    }
    return reopened
  })
}

/** The saved progress of an import, for its page: the running job's own when it runs here. */
export async function loadImportState(id: string): Promise<ImportState | null> {
  const running = active?.id === id ? active.state : null
  if (running !== null) return running
  const record = await getLibrary().getImport(id)
  return record === undefined ? null : sanitizeImportState(record.state)
}

/** Tests only: forgets the queue and stops the running import. */
export function resetImportRunner(): void {
  active?.controller.abort(CANCEL)
  active = null
  queue.length = 0
  locks.clear()
  resetImportLocks()
  generation++
  draining = false
  watching = null
  useImportRunner.setState({ activeId: null, activity: {}, queued: [], recording: [] })
}
