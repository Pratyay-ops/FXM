/**
 * How a library snapshot is stored in the sync gist: one manifest file and the parts it lists.
 *
 * - **The manifest**, `fxm-library-sync.json`, says what the gist is (`format`, `version`), which
 *   FXM wrote it, the app settings, the **revision** (a random ID per push) and its
 *   **ancestors** (the revisions it was merged from, newest first), and every part with its
 *   table, size and hash. Readers trust only what the manifest lists.
 * - **Parts** hold the rows of one table, in the record shapes of a library backup. GitHub's API
 *   returns at most about 1 MB of each file (larger ones come back truncated), so parts stay
 *   well under that. Rows are spread over hash buckets that double as a table grows, so a
 *   change rewrites one small part. Plays are cut into runs of whole days, and the newest day
 *   has a part of its own: a new play rewrites only that small part.
 * - **Part names include a hash of their content.** A push uploads only parts whose content
 *   changed, and a part is never rewritten in place: a reader always finds the parts its
 *   manifest names, even while a large push is still uploading in several requests.
 *
 * @module
 */

import { APP_NAME, APP_VERSION, type JsonObject } from '@fxm/core'
import { BACKUP_VERSION } from '../../db/backup'
import { SCHEMA_VERSION } from '../../db/database'
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
  /** For `too-large`: what doesn't fit, for people, e.g. a playlist's name. */
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

/** What a too-large row is, for people. */
function describeRow(table: SyncTable, value: unknown): string {
  if (table === 'playlists' && typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name
    if (typeof name === 'string') return `the playlist “${name}”`
  }
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

/** Encodes a snapshot as a manifest and parts. Throws `too-large` when it can't fit a gist. */
export function encodeSnapshot(
  snapshot: SyncSnapshot,
  meta: { revision: string; ancestors: readonly string[]; savedAt: Date },
): EncodedSnapshot {
  const rows = snapshotRows(snapshot)
  const parts: Part[] = []
  for (const table of SYNC_TABLES) {
    const keyOf = KEYS[table] as (row: unknown) => string
    const sized = rows[table].map((value): Row => {
      const json = canonicalJson(value)
      const row: Row = { key: keyOf(value), json, bytes: utf8Length(json) + 1 }
      if (row.bytes > MAX_PART_BYTES - 200) {
        const what = describeRow(table, value)
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
const FILE = /^fxm-[A-Za-z]+-[A-Za-z0-9.-]+\.json$/

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
      !FILE.test(part.file) ||
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
  const app = isRecord(data.app) ? data.app : {}
  return {
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
  }
}

/** A file of the gist as the decoder needs it. */
export interface GistFileContent {
  content?: string | undefined
  /** GitHub returned only the start of the file. */
  truncated?: boolean | undefined
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
  return snapshotFromRows(rows, manifest.appSettings)
}
