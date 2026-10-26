/**
 * How a library snapshot is stored in the sync gist: one manifest file and the parts it lists.
 *
 * - **The manifest**, `fxm-library-sync.json`, says what the gist is (`format`, `version`), which
 *   FXM wrote it, the app settings, the **revision** (a random ID per push) and its
 *   **ancestors** (the revisions it was merged from, newest first), the start of the writer's
 *   history window, and every part with its table, size and hash, plus the parts of the
 *   manifest it replaced that the gist still holds. Readers trust only what the manifest lists.
 * - **Parts** hold the rows of one table, in the record shapes of a library backup. GitHub's API
 *   returns at most about 1 MB of each file (larger ones come back truncated), so parts stay
 *   well under that. Rows are spread over hash buckets that double as a table grows, so a
 *   change rewrites one small part. Plays are cut into runs of whole days, and the newest day
 *   has a part of its own: a new play rewrites only that small part. A long playlist goes in
 *   pieces, so a playlist of any length fits.
 * - **Part names include a hash of their content.** A push uploads only parts whose content
 *   changed, and a part is never rewritten in place: a reader always finds the parts its
 *   manifest names, even while a large push is still uploading in several requests.
 *
 * @module
 */

import { APP_NAME, APP_VERSION, type EntityId, type JsonObject } from '@fxm/core'
import { BACKUP_VERSION } from '../../db/backup'
import { SCHEMA_VERSION } from '../../db/database'
import type { PlaylistRecord } from '../../db/types'
import { canonicalJson, hash53, hashHex, utf8Length } from './canonical'
import {
  cleanJsonObject,
  historyKey,
  isSyncTable,
  SYNC_TABLES,
  type SyncSnapshot,
  type SyncTable,
  snapshotFromRows,
  snapshotRows,
} from './snapshot'

/** The manifest's file name. A gist with this file is an FXM sync gist. */
export const MANIFEST_FILE = 'fxm-library-sync.json'

/** What a sync manifest says it is. */
export const SYNC_FORMAT = 'fxm-library-sync'

/** The sync format's version. Devices refuse gists from a newer one. */
export const SYNC_FORMAT_VERSION = 1

/** What a part file says it is. */
export const PART_FORMAT = 'fxm-library-sync-part'

/** Most ancestors a manifest lists. Older ones are dropped. */
export const MAX_ANCESTORS = 1000

/**
 * The size parts aim for, in bytes of UTF-8. Small, because a push uploads every part that
 * changed whole: playing a song changes its track's record, for example.
 */
export const TARGET_PART_BYTES = 64 * 1024

/** The size of a run of older plays. Larger than other parts: older plays rarely change. */
export const TARGET_HISTORY_BYTES = 768 * 1024

/** The largest part, safely under the 1 MB GitHub returns of each file. */
export const MAX_PART_BYTES = 900_000

/**
 * Playlists whose record is larger than this, in bytes, go into the gist in pieces of about
 * this size (a few hundred songs each).
 */
export const PLAYLIST_PIECE_BYTES = 32 * 1024

/** Most hash buckets one table is spread over. */
export const MAX_BUCKETS = 32

/**
 * Most parts one manifest lists. GitHub lists at most 300 files of a gist, and a gist holds the
 * parts of two manifests for a while (see `engine.ts`), so twice this plus the manifest fits.
 */
export const MAX_PARTS = 140

/** One part file, as the manifest lists it. */
export interface PartRef {
  /** Its file name in the gist. */
  file: string
  /** The table whose rows it holds. */
  table: SyncTable
  /** How many rows. */
  rows: number
  /** Its size in bytes. */
  bytes: number
  /** {@link hashHex} of its canonical JSON. */
  hash: string
}

/** The manifest of a sync gist. */
export interface SyncManifest {
  format: typeof SYNC_FORMAT
  version: number
  /** A random ID for this push. */
  revision: string
  /** The revisions this one was merged from, newest first, at most {@link MAX_ANCESTORS}. */
  ancestors: string[]
  /** When it was pushed, as an ISO 8601 date. */
  savedAt: string
  /**
   * The start of the writer's history window, as epoch milliseconds: the gist lacks older plays
   * because they fell out of that window, not because anyone deleted them. Absent from gists of
   * an earlier FXM.
   */
  historySince?: number
  /** The app that pushed it. */
  app: { name: string; version: string }
  /** The library database schema of the app that pushed it. */
  schemaVersion: number
  /** The backup format version whose record shapes the parts use. */
  backupVersion: number
  /** The app settings. */
  appSettings: JsonObject
  /** Every part, sorted by file name. */
  parts: PartRef[]
  /**
   * Parts of the manifest this one replaced that it doesn't list, which the gist still holds for
   * devices that were reading or pushing at the same time. The next push deletes them.
   */
  previous: string[]
}

/** Why a gist can't be read or written as a sync gist. */
export type SyncFormatErrorCode =
  /** The gist has no manifest: it isn't an FXM sync gist. */
  | 'not-sync-gist'
  /** It comes from a newer FXM, whose data this version could damage. */
  | 'too-new'
  /** A file is missing, unreadable or doesn't match its hash: it was changed outside FXM. */
  | 'corrupt'
  /** The library doesn't fit in a gist (see `detail`). */
  | 'too-large'

/** A gist that can't be read or written, with a {@link SyncFormatErrorCode}. */
export class SyncFormatError extends Error {
  override readonly name = 'SyncFormatError'
  readonly code: SyncFormatErrorCode
  /** For `too-large`: what doesn't fit, for people, e.g. "an item of settings". */
  readonly detail: string | undefined

  constructor(code: SyncFormatErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** A snapshot as gist files. */
export interface EncodedSnapshot {
  manifest: SyncManifest
  /** The manifest file's content. */
  manifestText: string
  /** Every part's content, by file name. */
  parts: Map<string, string>
}

interface Row {
  key: string
  json: string
  bytes: number
  /** Rows of history: when the play started. */
  playedAt?: number
}

interface Part {
  ref: PartRef
  content: string
}

/** The names part files have: `fxm-<table>-<label>-<hash>.json`. */
const FILE = /^fxm-[A-Za-z]+-[A-Za-z0-9.-]+\.json$/

/** Whether `name` can be an FXM part file (the manifest isn't one). */
export function isPartFile(name: string): boolean {
  return name !== MANIFEST_FILE && FILE.test(name)
}

/** A part file's content: canonical JSON, built from rows that already are. */
function partContent(table: SyncTable, rows: readonly Row[]): string {
  // canonicalJson({ format, rows, table }): its keys are already in sorted order.
  return `{"format":${JSON.stringify(PART_FORMAT)},"rows":[${rows.map((row) => row.json).join(',')}],"table":${JSON.stringify(table)}}`
}

function makePart(table: SyncTable, label: string, rows: readonly Row[]): Part {
  const content = partContent(table, rows)
  const hash = hashHex(content)
  return {
    ref: {
      file: `fxm-${table}-${label}-${hash}.json`,
      table,
      rows: rows.length,
      bytes: utf8Length(content),
      hash,
    },
    content,
  }
}

const sumBytes = (rows: readonly Row[]) => rows.reduce((total, row) => total + row.bytes, 0)

/** `rows` cut, in order, into runs of at most `max` bytes. */
function chunks(rows: readonly Row[], max: number): Row[][] {
  const result: Row[][] = []
  let current: Row[] = []
  let bytes = 0
  for (const row of rows) {
    if (current.length > 0 && bytes + row.bytes > max) {
      result.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += row.bytes
  }
  if (current.length > 0) result.push(current)
  return result
}

/** Spreads a table's rows over hash buckets, doubling them until each fits. */
function bucketParts(table: SyncTable, rows: readonly Row[]): Part[] {
  if (rows.length === 0) return []
  const total = sumBytes(rows)
  let count = 1
  while (count < MAX_BUCKETS && total / count > TARGET_PART_BYTES) count *= 2
  let buckets: Row[][]
  for (;;) {
    buckets = Array.from({ length: count }, () => [])
    for (const row of rows) buckets[hash53(row.key) % count]?.push(row)
    if (count >= MAX_BUCKETS || buckets.every((bucket) => sumBytes(bucket) <= MAX_PART_BYTES)) break
    count *= 2
  }
  return buckets.flatMap((bucket, index) =>
    chunks(bucket, MAX_PART_BYTES).map((chunk, part) =>
      makePart(table, `${index}of${count}${part > 0 ? `.${part}` : ''}`, chunk),
    ),
  )
}

/** The UTC day of a time, as `YYYYMMDD`. */
function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * Cuts plays, oldest first, into runs of whole days of about {@link TARGET_HISTORY_BYTES}, and
 * gives the newest day (of the data, not the clock, so every device cuts alike) a part of its
 * own, the one that new plays change.
 */
function historyParts(rows: readonly Row[]): Part[] {
  const last = rows.at(-1)
  if (last === undefined) return []
  const newestDay = utcDay(last.playedAt ?? 0)
  const firstOfNewest = rows.findIndex((row) => utcDay(row.playedAt ?? 0) === newestDay)
  const parts: Part[] = []
  let current: Row[] = []
  let bytes = 0
  let day = ''
  const flush = () => {
    if (current.length === 0) return
    const first = utcDay(current[0]?.playedAt ?? 0)
    parts.push(makePart('history', `d${first}`, current))
    current = []
    bytes = 0
  }
  for (const row of rows.slice(0, firstOfNewest)) {
    const rowDay = utcDay(row.playedAt ?? 0)
    const newDay = rowDay !== day
    if (
      current.length > 0 &&
      ((newDay && bytes + row.bytes > TARGET_HISTORY_BYTES) || bytes + row.bytes > MAX_PART_BYTES)
    ) {
      flush()
    }
    current.push(row)
    bytes += row.bytes
    day = rowDay
  }
  flush()
  chunks(rows.slice(firstOfNewest), MAX_PART_BYTES).forEach((chunk, index) => {
    parts.push(makePart('history', `d${newestDay}${index > 0 ? `.${index}` : ''}`, chunk))
  })
  return parts
}

/** One row of a table as it goes into a part, before it is sized. */
interface Value {
  key: string
  value: unknown
}

/**
 * A playlist as rows of a part. A long one (its record larger than {@link PLAYLIST_PIECE_BYTES})
 * goes in pieces: the record with the first run of its songs and `pieces`, the number of rows,
 * then a row `{ id, piece, trackIds, addedAt }` for each further run, `piece` counting from 1.
 * The pieces spread over parts like any rows, so a playlist of any length fits a gist, and
 * {@link decodeSnapshot} joins them again.
 */
function playlistValues(record: PlaylistRecord): Value[] {
  const whole = [{ key: record.id, value: record }]
  if (utf8Length(canonicalJson(record)) <= PLAYLIST_PIECE_BYTES) return whole
  const runs: EntityId<'track'>[][] = []
  let run: EntityId<'track'>[] = []
  let bytes = 0
  for (const id of record.trackIds) {
    // The ID in `trackIds`, and with its date in `addedAt`.
    const idBytes = utf8Length(JSON.stringify(id)) + 1
    const at = Object.hasOwn(record.addedAt, id) ? record.addedAt[id] : undefined
    const size = idBytes + (at === undefined ? 0 : idBytes + String(at).length + 1)
    if (run.length > 0 && bytes + size > PLAYLIST_PIECE_BYTES) {
      runs.push(run)
      run = []
      bytes = 0
    }
    run.push(id)
    bytes += size
  }
  if (run.length > 0) runs.push(run)
  // Large for another reason (a long description, much artwork): it stays whole.
  if (runs.length < 2) return whole
  const datesOf = (ids: readonly EntityId<'track'>[]) => {
    const dates: Record<string, number> = {}
    for (const id of ids) {
      const at = Object.hasOwn(record.addedAt, id) ? record.addedAt[id] : undefined
      if (at !== undefined) dates[id] = at
    }
    return dates
  }
  const [first = [], ...rest] = runs
  return [
    {
      key: record.id,
      value: { ...record, trackIds: first, addedAt: datesOf(first), pieces: runs.length },
    },
    ...rest.map((ids, index) => ({
      key: `${record.id}#${index + 1}`,
      value: { id: record.id, piece: index + 1, trackIds: ids, addedAt: datesOf(ids) },
    })),
  ]
}

/** What a too-large row is, for people. */
function describeRow(table: SyncTable): string {
  return `an item of ${table}`
}

const KEYS: Readonly<Record<SyncTable, (row: never) => string>> = {
  tracks: (row: { id: string }) => row.id,
  likes: (row: { key: string }) => row.key,
  playlists: (row: { id: string }) => row.id,
  orders: (row: { id: string }) => row.id,
  follows: (row: { key: string }) => row.key,
  history: historyKey as (row: never) => string,
  settings: (row: { key: string }) => row.key,
  matchCache: (row: { key: string }) => row.key,
}

/** What a manifest says besides the library. */
export interface ManifestMeta {
  revision: string
  ancestors: readonly string[]
  savedAt: Date
  /** The start of this device's history window (see {@link SyncManifest.historySince}). */
  historySince?: number
  /** The parts of the manifest this push replaces (see {@link SyncManifest.previous}). */
  previous?: readonly string[]
}

/** Encodes a snapshot as a manifest and parts. Throws `too-large` when it can't fit a gist. */
export function encodeSnapshot(snapshot: SyncSnapshot, meta: ManifestMeta): EncodedSnapshot {
  const rows = snapshotRows(snapshot)
  const parts: Part[] = []
  for (const table of SYNC_TABLES) {
    const keyOf = KEYS[table] as (row: unknown) => string
    const values: Value[] =
      table === 'playlists'
        ? (rows.playlists as readonly PlaylistRecord[]).flatMap((record) => playlistValues(record))
        : rows[table].map((value) => ({ key: keyOf(value), value }))
    const sized = values.map(({ key, value }): Row => {
      const json = canonicalJson(value)
      const row: Row = { key, json, bytes: utf8Length(json) + 1 }
      if (row.bytes > MAX_PART_BYTES - 200) {
        const what = describeRow(table)
        throw new SyncFormatError('too-large', `${what} is too large to sync`, what)
      }
      if (table === 'history') row.playedAt = (value as { playedAt: number }).playedAt
      return row
    })
    parts.push(...(table === 'history' ? historyParts(sized) : bucketParts(table, sized)))
  }
  if (parts.length > MAX_PARTS) {
    throw new SyncFormatError('too-large', 'The library has too many items to sync', 'the library')
  }
  parts.sort((a, b) => (a.ref.file < b.ref.file ? -1 : 1))
  const files = new Set(parts.map((part) => part.ref.file))
  const manifest: SyncManifest = {
    format: SYNC_FORMAT,
    version: SYNC_FORMAT_VERSION,
    revision: meta.revision,
    ancestors: [...new Set(meta.ancestors)]
      .filter((id) => id !== meta.revision)
      .slice(0, MAX_ANCESTORS),
    savedAt: meta.savedAt.toISOString(),
    app: { name: APP_NAME, version: APP_VERSION },
    schemaVersion: SCHEMA_VERSION,
    backupVersion: BACKUP_VERSION,
    appSettings: snapshot.appSettings,
    parts: parts.map((part) => part.ref),
    previous: [...new Set(meta.previous ?? [])]
      .filter((file) => isPartFile(file) && !files.has(file))
      .sort(),
  }
  if (meta.historySince !== undefined) {
    manifest.historySince = Math.max(0, Math.floor(meta.historySince))
  }
  return {
    manifest,
    manifestText: `${JSON.stringify(manifest)}\n`,
    parts: new Map(parts.map((part) => [part.ref.file, part.content])),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REVISION = /^[0-9a-f]{8,64}$/
const HASH = /^[0-9a-f]{14}$/

/** A new random revision ID: 16 hex digits. */
export function newRevision(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

function corrupt(message: string): SyncFormatError {
  return new SyncFormatError('corrupt', message)
}

/**
 * Reads a manifest file's content. Throws `not-sync-gist` without one, `too-new` for a gist a
 * newer FXM wrote, and `corrupt` when it can't be read.
 */
export function parseManifest(text: string | undefined): SyncManifest {
  if (text === undefined) throw new SyncFormatError('not-sync-gist', 'The gist has no manifest')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw corrupt('The manifest is not valid JSON')
  }
  if (!isRecord(data) || data.format !== SYNC_FORMAT) {
    throw new SyncFormatError('not-sync-gist', 'The gist is not an FXM sync gist')
  }
  const version = count(data.version)
  if (version === undefined || version < 1) throw corrupt('The manifest has no valid version')
  const schemaVersion = count(data.schemaVersion) ?? 0
  const backupVersion = count(data.backupVersion) ?? 1
  if (
    version > SYNC_FORMAT_VERSION ||
    schemaVersion > SCHEMA_VERSION ||
    backupVersion > BACKUP_VERSION
  ) {
    throw new SyncFormatError('too-new', 'The gist comes from a newer version of FXM')
  }
  if (typeof data.revision !== 'string' || !REVISION.test(data.revision)) {
    throw corrupt('The manifest has no valid revision')
  }
  if (!Array.isArray(data.parts)) throw corrupt('The manifest lists no parts')
  const parts: PartRef[] = []
  const files = new Set<string>()
  for (const part of data.parts) {
    if (
      !isRecord(part) ||
      typeof part.file !== 'string' ||
      !isPartFile(part.file) ||
      files.has(part.file) ||
      !isSyncTable(part.table) ||
      typeof part.hash !== 'string' ||
      !HASH.test(part.hash)
    ) {
      throw corrupt('The manifest lists an invalid part')
    }
    files.add(part.file)
    parts.push({
      file: part.file,
      table: part.table,
      rows: count(part.rows) ?? 0,
      bytes: count(part.bytes) ?? 0,
      hash: part.hash,
    })
  }
  const ancestors = Array.isArray(data.ancestors)
    ? data.ancestors
        .filter((id): id is string => typeof id === 'string' && REVISION.test(id))
        .slice(0, MAX_ANCESTORS)
    : []
  const previous = Array.isArray(data.previous)
    ? [
        ...new Set(
          data.previous.filter(
            (file): file is string =>
              typeof file === 'string' && isPartFile(file) && !files.has(file),
          ),
        ),
      ].slice(0, MAX_PARTS)
    : []
  const app = isRecord(data.app) ? data.app : {}
  const manifest: SyncManifest = {
    format: SYNC_FORMAT,
    version,
    revision: data.revision,
    ancestors,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    app: {
      name: typeof app.name === 'string' ? app.name : APP_NAME,
      version: typeof app.version === 'string' ? app.version : '',
    },
    schemaVersion,
    backupVersion,
    appSettings: cleanJsonObject(data.appSettings),
    parts,
    previous,
  }
  const historySince = count(data.historySince)
  if (historySince !== undefined) manifest.historySince = historySince
  return manifest
}

/** A file of the gist as the decoder needs it. */
export interface GistFileContent {
  content?: string | undefined
  /** GitHub returned only the start of the file. */
  truncated?: boolean | undefined
}

/**
 * The playlists of a gist with the pieces of long ones joined (see `playlistValues`). Throws
 * `corrupt` when a piece is missing, doubled or without its playlist.
 */
function joinPlaylistPieces(rows: readonly unknown[]): unknown[] {
  const pieces = new Map<string, Map<number, Record<string, unknown>>>()
  const records: unknown[] = []
  for (const row of rows) {
    if (!isRecord(row) || !Object.hasOwn(row, 'piece')) {
      records.push(row)
      continue
    }
    const index = count(row.piece)
    if (typeof row.id !== 'string' || index === undefined || index < 1) {
      throw corrupt('A piece of a playlist is damaged')
    }
    const byIndex = pieces.get(row.id) ?? new Map<number, Record<string, unknown>>()
    if (byIndex.has(index)) throw corrupt('A piece of a playlist is there twice')
    byIndex.set(index, row)
    pieces.set(row.id, byIndex)
  }
  const joined = records.map((row) => {
    if (!isRecord(row) || !Object.hasOwn(row, 'pieces')) return row
    const total = count(row.pieces)
    if (typeof row.id !== 'string' || total === undefined || total < 2) {
      throw corrupt('A long playlist is damaged')
    }
    const byIndex = pieces.get(row.id)
    pieces.delete(row.id)
    if (byIndex?.size !== total - 1 || !Array.isArray(row.trackIds)) {
      throw corrupt('The gist lacks part of a long playlist')
    }
    const trackIds: unknown[] = [...row.trackIds]
    // Without a prototype: these keys come from the gist.
    const addedAt: Record<string, unknown> = Object.create(null)
    const addDates = (dates: unknown) => {
      if (!isRecord(dates)) return
      for (const [id, at] of Object.entries(dates)) addedAt[id] = at
    }
    addDates(row.addedAt)
    for (let index = 1; index < total; index++) {
      const piece = byIndex.get(index)
      if (piece === undefined || !Array.isArray(piece.trackIds)) {
        throw corrupt('The gist lacks part of a long playlist')
      }
      for (const id of piece.trackIds) trackIds.push(id)
      addDates(piece.addedAt)
    }
    const { pieces: _pieces, ...record } = row
    return { ...record, trackIds, addedAt }
  })
  if (pieces.size > 0) throw corrupt('The gist holds a piece of a playlist it lacks')
  return joined
}

/**
 * Reads the parts a manifest lists into a snapshot. Every part must be present, whole and
 * match its hash (else `corrupt`); every record goes through the backup's guards, and invalid
 * ones are dropped and counted.
 */
export function decodeSnapshot(
  manifest: SyncManifest,
  fileOf: (name: string) => GistFileContent | undefined,
): { snapshot: SyncSnapshot; skipped: number } {
  const rows: Record<SyncTable, unknown[]> = {
    tracks: [],
    likes: [],
    playlists: [],
    orders: [],
    follows: [],
    history: [],
    settings: [],
    matchCache: [],
  }
  for (const part of manifest.parts) {
    const file = fileOf(part.file)
    if (file === undefined || typeof file.content !== 'string') {
      throw corrupt(`The gist is missing ${part.file}`)
    }
    if (file.truncated === true) throw corrupt(`GitHub returned ${part.file} cut short`)
    let data: unknown
    try {
      data = JSON.parse(file.content)
    } catch {
      throw corrupt(`${part.file} is not valid JSON`)
    }
    if (
      !isRecord(data) ||
      data.format !== PART_FORMAT ||
      data.table !== part.table ||
      !Array.isArray(data.rows)
    ) {
      throw corrupt(`${part.file} is not a part of this gist`)
    }
    // Hashed in canonical form, so a change of whitespace on the way doesn't matter.
    if (hashHex(canonicalJson(data)) !== part.hash) throw corrupt(`${part.file} was changed`)
    const target = rows[part.table]
    for (const row of data.rows as unknown[]) target.push(row)
  }
  rows.playlists = joinPlaylistPieces(rows.playlists)
  return snapshotFromRows(rows, manifest.appSettings)
}
