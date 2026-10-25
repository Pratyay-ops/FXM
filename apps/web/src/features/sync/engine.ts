/**
 * One sync of the library with its gist, and the reads that set sync up.
 *
 * A sync **reads** the gist (a conditional read when the device knows its ETag, which GitHub
 * answers with 304 when nothing changed), **merges** it into the library in one transaction
 * (see `library-io.ts` and `merge.ts`), and **pushes** the result when the gist lacks part of
 * it: only the parts whose content changed, with a new manifest, as one revision. Then it saves
 * the new **base** (see `base-store.ts`).
 *
 * Two devices can push at nearly the same moment. Right before pushing, a sync checks with a
 * conditional read that the gist is still the one it merged, and merges again if not. If a
 * push still overwrites another one, nothing is lost: the overwritten device finds that the
 * gist no longer descends from its base, so the next merge treats nothing it lacks as deleted,
 * and pushes it back.
 *
 * Plays sync for {@link HISTORY_WINDOW_MS} (90 days), and the gist carries only the track
 * metadata the rest uses (see `snapshot.ts`): GitHub sends the whole gist back after every
 * update, so it stays as small as it can.
 *
 * @module
 */

import type { JsonObject } from '@fxm/core'
import type { LibraryRepo } from '../../db/repo'
import type { BaseStore, SyncBase } from './base-store'
import { utf8Length } from './canonical'
import {
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  MANIFEST_FILE,
  MAX_ANCESTORS,
  newRevision,
  type PartRef,
  parseManifest,
  SyncFormatError,
  type SyncManifest,
} from './gist-format'
import { type Gist, type GistApi, GitHubError } from './github'
import { mergeIntoLibrary, readLibrarySnapshot } from './library-io'
import type { ConflictCopy, MergeNotice } from './merge'
import {
  differOnlyInBackground,
  HISTORY_EDGE_MS,
  HISTORY_WINDOW_MS,
  type SyncSnapshot,
  snapshotFingerprint,
  withHistorySince,
  withUsedTracks,
} from './snapshot'

/** The description of a sync gist, for people who find it among their gists. */
export const GIST_DESCRIPTION =
  'FXM library sync · kept up to date by the FXM app, please don’t edit'

/** The largest request body FXM sends, in bytes: a larger push goes up in several requests. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/** Why a sync failed. */
export type SyncErrorCode =
  /** GitHub refused the token: it is wrong, expired or revoked. */
  | 'unauthorized'
  /** The token may not change gists: it lacks the Gists permission. */
  | 'forbidden'
  /** The gist is gone from GitHub. */
  | 'gone'
  /** The gist belongs to another GitHub account. */
  | 'not-owner'
  /** The gist isn't an FXM sync gist. */
  | 'not-sync-gist'
  /** The gist was written by a newer FXM. */
  | 'too-new'
  /** The gist was changed outside FXM and can't be read. */
  | 'corrupt'
  /** The library doesn't fit in a gist. */
  | 'too-large'
  /** GitHub asked to slow down. */
  | 'rate-limited'
  /** GitHub couldn't be reached. */
  | 'network'
  /** The gist kept changing while this device synced. */
  | 'busy'
  /** Anything else: GitHub failed, or the library couldn't be read or written. */
  | 'failed'

/** A failed sync, with a {@link SyncErrorCode}. */
export class SyncError extends Error {
  override readonly name = 'SyncError'
  readonly code: SyncErrorCode
  /** For `rate-limited`: how long to wait. */
  readonly retryAfterMs: number | undefined
  /** For `too-large`: what doesn't fit, for people. */
  readonly detail: string | undefined

  constructor(
    code: SyncErrorCode,
    message: string,
    options: {
      retryAfterMs?: number | undefined
      detail?: string | undefined
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryAfterMs = options.retryAfterMs
    this.detail = options.detail
  }
}

/** Whether `error` is a cancellation, which isn't a failure to report. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** `error` as a {@link SyncError}; cancellations pass through. */
export function toSyncError(error: unknown): unknown {
  if (error instanceof SyncError || isAbort(error)) return error
  if (error instanceof SyncFormatError) {
    return new SyncError(error.code, error.message, { detail: error.detail, cause: error })
  }
  if (error instanceof GitHubError) {
    switch (error.code) {
      case 'unauthorized':
        return new SyncError('unauthorized', error.message, { cause: error })
      case 'forbidden':
        return new SyncError('forbidden', error.message, { cause: error })
      case 'not-found':
        return new SyncError('gone', error.message, { cause: error })
      case 'rate-limited':
        return new SyncError('rate-limited', error.message, {
          retryAfterMs: error.retryAfterMs,
          cause: error,
        })
      case 'network':
      case 'timeout':
        return new SyncError('network', error.message, { cause: error })
      default:
        return new SyncError('failed', error.message, { cause: error })
    }
  }
  return new SyncError('failed', error instanceof Error ? error.message : String(error), {
    cause: error,
  })
}

/** What a sync needs. */
export interface SyncDeps {
  repo: LibraryRepo
  github: GistApi
  bases: BaseStore
  /** The token's GitHub login: sync refuses a gist of another account. */
  login: string
  /** The app's own settings, which sync carries too, and their defaults. */
  appSettings: { read(): JsonObject; apply(settings: JsonObject): void; defaults?: JsonObject }
  /** The clock, as epoch milliseconds. */
  now?: () => number
  /** New revision IDs. */
  revision?: () => string
  /** The largest request body, in bytes ({@link MAX_REQUEST_BYTES}); tests make it small. */
  maxRequestBytes?: number
  /** Waits between the requests of a large upload; GitHub asks for a second (tests skip it). */
  pause?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** GitHub asks for at least a second between many write requests. */
const WRITE_SPACING_MS = 1000

/** What a sync did. */
export interface SyncReport {
  gistId: string
  /** The gist's page on GitHub. */
  gistUrl: string
  /** Whether this sync created the gist. */
  created: boolean
  /** How many records the merge added, changed or removed on this device. */
  pulled: number
  /** Whether this sync updated the gist. */
  pushed: boolean
  /** Playlists kept twice by this sync. */
  copies: ConflictCopy[]
  /** Deleted playlists this sync kept. */
  notices: MergeNotice[]
  /** Records of the gist left out as invalid. */
  skipped: number
  /** The size of the gist's library, in bytes. */
  bytes: number
  /** Plays waited for a later push (see `pushBackground`). */
  deferred: boolean
}

/** A gist's page, for a link. */
export function gistPageUrl(login: string, gistId: string): string {
  return `https://gist.github.com/${encodeURIComponent(login)}/${encodeURIComponent(gistId)}`
}

/** The page GitHub names for a gist, if it is one on gist.github.com: the UI links to it. */
function pageOf(gist: Gist): string | undefined {
  return gist.htmlUrl.startsWith('https://gist.github.com/') ? gist.htmlUrl : undefined
}

function checkOwner(gist: Gist, login: string): void {
  if (gist.owner !== undefined && gist.owner.toLowerCase() !== login.toLowerCase()) {
    throw new SyncError('not-owner', 'The gist belongs to another GitHub account')
  }
}

function readManifest(gist: Gist): SyncManifest {
  if (gist.truncated) throw new SyncError('corrupt', 'The gist has too many files')
  const file = gist.files[MANIFEST_FILE]
  if (file?.truncated) throw new SyncError('corrupt', 'GitHub returned the manifest cut short')
  return parseManifest(file?.content)
}

/** A gist write: GitHub's 404 there means the token may not write it. */
async function write<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.code === 'not-found' || error.code === 'forbidden')
    ) {
      throw new SyncError('forbidden', 'The token may not change gists', { cause: error })
    }
    throw error
  }
}

/** Splits files into request bodies of at most `budget` bytes each (a larger file goes alone). */
function batches(files: readonly [string, string][], budget: number): [string, string][][] {
  const result: [string, string][][] = []
  let current: [string, string][] = []
  let bytes = 0
  for (const file of files) {
    const size = utf8Length(file[1]) + file[0].length + 64
    if (current.length > 0 && bytes + size > budget) {
      result.push(current)
      current = []
      bytes = 0
    }
    current.push(file)
    bytes += size
  }
  if (current.length > 0) result.push(current)
  return result
}

/** The size of a library's parts, in bytes. */
function partsBytes(parts: readonly PartRef[]): number {
  return parts.reduce((total, part) => total + part.bytes, 0)
}

/**
 * Uploads an encoded snapshot over a gist that holds `existing` files and the manifest
 * `replaced`: new parts first (in several requests if they are large), then the manifest, as
 * the last request. Until then, readers keep reading the old manifest's parts.
 *
 * The parts of the replaced manifest stay too, one push longer: if another device's push lands
 * between this device's last check and its upload, either manifest that ends up in the gist
 * still finds all its parts. Older FXM files go with the manifest's request.
 */
async function upload(
  github: GistApi,
  gistId: string,
  encoded: EncodedSnapshot,
  existing: ReadonlySet<string>,
  replaced: readonly PartRef[],
  maxRequestBytes: number,
  pause: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<{ gist: Gist; etag?: string }> {
  const uploads = [...encoded.parts].filter(([file]) => !existing.has(file))
  const kept = new Set(replaced.map((part) => part.file))
  const deletions = [...existing].filter(
    (file) =>
      file !== MANIFEST_FILE &&
      /^fxm-.*\.json$/.test(file) &&
      !encoded.parts.has(file) &&
      !kept.has(file),
  )
  const groups = batches(uploads, maxRequestBytes - utf8Length(encoded.manifestText))
  for (const group of groups.slice(0, -1)) {
    await write(() => github.updateGist(gistId, Object.fromEntries(group), signal))
    await pause(WRITE_SPACING_MS)
  }
  const last: Record<string, string | null> = Object.fromEntries(groups.at(-1) ?? [])
  for (const file of deletions) last[file] = null
  last[MANIFEST_FILE] = encoded.manifestText
  return write(() => github.updateGist(gistId, last, signal))
}

/** The gist as one sync round sees it. */
interface RemoteState {
  /** Its library, with the plays of the history window. */
  snapshot: SyncSnapshot
  revision: string
  ancestors: string[]
  parts: PartRef[]
  /** Every file name in the gist. */
  files: string[]
  etag: string | undefined
  url: string | undefined
  /** Whether the gist descends from this device's base. */
  fromBase: boolean
  /** The gist is older than the base: GitHub served a read from before the last push. */
  stale: boolean
  skipped: number
}

async function readRemote(
  deps: SyncDeps,
  gistId: string,
  base: SyncBase | undefined,
  historySince: number,
  signal: AbortSignal | undefined,
): Promise<RemoteState> {
  const read = await deps.github.getGist(gistId, {
    ...(base?.etag === undefined ? {} : { etag: base.etag }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (read.notModified) {
    if (base === undefined) {
      throw new SyncError('failed', 'GitHub answered “not modified” to a first read')
    }
    return {
      snapshot: withHistorySince(base.snapshot, historySince),
      revision: base.revision,
      ancestors: base.ancestors,
      parts: base.parts,
      files: base.files,
      etag: read.etag ?? base.etag,
      url: undefined,
      fromBase: true,
      stale: false,
      skipped: 0,
    }
  }
  const { gist } = read
  checkOwner(gist, deps.login)
  const manifest = readManifest(gist)
  const shared = {
    revision: manifest.revision,
    ancestors: manifest.ancestors,
    parts: manifest.parts,
    files: Object.keys(gist.files),
    etag: read.etag,
    url: pageOf(gist),
  }
  if (base !== undefined && manifest.revision === base.revision) {
    // Only the gist's metadata changed (or its ETag): its library is the base.
    const snapshot = withHistorySince(base.snapshot, historySince)
    return { ...shared, snapshot, fromBase: true, stale: false, skipped: 0 }
  }
  if (base?.ancestors.includes(manifest.revision)) {
    return { ...shared, snapshot: base.snapshot, fromBase: true, stale: true, skipped: 0 }
  }
  const decoded = decodeSnapshot(manifest, (name) => gist.files[name])
  const snapshot = withHistorySince(decoded.snapshot, historySince)
  const fromBase = base !== undefined && manifest.ancestors.includes(base.revision)
  return { ...shared, snapshot, fromBase, stale: false, skipped: decoded.skipped }
}

/** The ancestors of a push merged from `remote` (and from `base`, if the gist didn't descend from it). */
function lineage(remote: RemoteState, base: SyncBase | undefined): string[] {
  const ids = [remote.revision, ...remote.ancestors]
  if (base !== undefined && !remote.fromBase) ids.push(base.revision, ...base.ancestors)
  return [...new Set(ids)].slice(0, MAX_ANCESTORS)
}

/** The base after writing `snapshot` (already in its gist form) as `revision`. */
function newBase(
  gistId: string,
  snapshot: SyncSnapshot,
  written: { revision: string; ancestors: string[]; parts: PartRef[]; files: string[] },
  etag: string | undefined,
  now: number,
): SyncBase {
  const base: SyncBase = {
    gistId,
    revision: written.revision,
    ancestors: written.ancestors,
    snapshot,
    fingerprint: snapshotFingerprint(snapshot),
    parts: written.parts,
    files: written.files,
    savedAt: now,
  }
  if (etag !== undefined) base.etag = etag
  return base
}

/** The library as a gist holds it: the plays of the window and the tracks they all use. */
async function localForGist(deps: SyncDeps, historySince: number): Promise<SyncSnapshot> {
  return withUsedTracks(
    await readLibrarySnapshot(deps.repo, deps.appSettings.read(), { historySince }),
  )
}

/** Creates a secret sync gist with this device's library. */
export async function createSyncGist(deps: SyncDeps, signal?: AbortSignal): Promise<SyncReport> {
  const now = deps.now ?? Date.now
  try {
    const snapshot = await localForGist(deps, now() - HISTORY_WINDOW_MS)
    const revision = (deps.revision ?? newRevision)()
    const encoded = encodeSnapshot(snapshot, { revision, ancestors: [], savedAt: new Date(now()) })
    const files = [...encoded.parts]
    const budget = deps.maxRequestBytes ?? MAX_REQUEST_BYTES
    const groups = batches(files, budget - utf8Length(encoded.manifestText))
    const first: Record<string, string> = Object.fromEntries(groups[0] ?? [])
    if (groups.length <= 1) first[MANIFEST_FILE] = encoded.manifestText
    let result = await write(() =>
      deps.github.createGist({ description: GIST_DESCRIPTION, files: first }, signal),
    )
    const gistId = result.gist.id
    try {
      for (const [index, group] of groups.slice(1).entries()) {
        await (deps.pause ?? sleep)(WRITE_SPACING_MS)
        const body: Record<string, string> = Object.fromEntries(group)
        if (index === groups.length - 2) body[MANIFEST_FILE] = encoded.manifestText
        result = await write(() => deps.github.updateGist(gistId, body, signal))
      }
    } catch (error) {
      // A large library goes up in several requests, the manifest last. Don't leave a gist
      // without one behind: nothing could find or use it.
      await deps.github.deleteGist(gistId).catch(() => {})
      throw error
    }
    const parts = encoded.manifest.parts
    await deps.bases.put(
      newBase(
        gistId,
        snapshot,
        { revision, ancestors: [], parts, files: Object.keys(result.gist.files) },
        result.etag,
        now(),
      ),
    )
    return {
      gistId,
      gistUrl: pageOf(result.gist) ?? gistPageUrl(deps.login, gistId),
      created: true,
      pulled: 0,
      pushed: true,
      copies: [],
      notices: [],
      skipped: 0,
      bytes: partsBytes(parts),
      deferred: false,
    }
  } catch (error) {
    throw toSyncError(error)
  }
}

/** How a sync runs. */
export interface SyncOptions {
  signal?: AbortSignal
  /**
   * For syncs that local changes trigger: when this device has synced with the gist before and
   * its library didn't change since, return `null` without contacting GitHub.
   */
  skipIfUnchanged?: boolean
  /**
   * Whether to push when only plays (and the track metadata they use) are new here. Without it,
   * they wait for a sync that pushes anyway, so a song played every few minutes doesn't mean a
   * push every few minutes. Default: true.
   */
  pushBackground?: boolean
}

/** Syncs the library with its gist (see the module documentation). */
export async function syncLibrary(
  deps: SyncDeps,
  gistId: string,
  options: SyncOptions = {},
): Promise<SyncReport | null> {
  const { signal, pushBackground = true } = options
  const now = deps.now ?? Date.now
  const historySince = now() - HISTORY_WINDOW_MS
  try {
    const stored = await deps.bases.get(gistId)
    const base =
      stored === undefined
        ? undefined
        : { ...stored, snapshot: withHistorySince(stored.snapshot, historySince) }
    if (options.skipIfUnchanged && base !== undefined) {
      const local = await localForGist(deps, historySince)
      if (snapshotFingerprint(local) === snapshotFingerprint(base.snapshot)) return null
    }
    const report: SyncReport = {
      gistId,
      gistUrl: gistPageUrl(deps.login, gistId),
      created: false,
      pulled: 0,
      pushed: false,
      copies: [],
      notices: [],
      skipped: 0,
      bytes: 0,
      deferred: false,
    }
    let refused: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await readRemote(deps, gistId, base, historySince, signal)
      if (remote.url !== undefined) report.gistUrl = remote.url
      report.skipped = remote.skipped
      report.bytes = partsBytes(remote.parts)
      if (remote.stale) {
        // GitHub served a read from before this device's last push: there is nothing newer to
        // merge, and pushing over it could undo that push. The next sync reads again.
        return report
      }
      const merge = await mergeIntoLibrary(deps.repo, {
        base: base?.snapshot,
        remote: remote.snapshot,
        remoteFromBase: remote.fromBase,
        appSettings: deps.appSettings.read(),
        appSettingsDefaults: deps.appSettings.defaults,
        historySince,
        historyDeletionsSince: historySince + HISTORY_EDGE_MS,
      })
      report.pulled += merge.changed
      report.copies.push(...merge.copies)
      report.notices.push(...merge.notices)
      deps.appSettings.apply(merge.snapshot.appSettings)
      const merged = withUsedTracks(merge.snapshot)
      const there = withUsedTracks(remote.snapshot)
      if (snapshotFingerprint(merged) === snapshotFingerprint(there)) {
        // The gist already holds the merged library.
        await deps.bases.put(newBase(gistId, there, remote, remote.etag, now()))
        return report
      }
      if (!pushBackground && differOnlyInBackground(merged, there)) {
        // Only plays are new here: they wait. The base is what the gist holds, so the next
        // sync that pushes carries them.
        await deps.bases.put(newBase(gistId, there, remote, remote.etag, now()))
        report.deferred = true
        return report
      }
      const revision = (deps.revision ?? newRevision)()
      const encoded = encodeSnapshot(merged, {
        revision,
        ancestors: lineage(remote, base),
        savedAt: new Date(now()),
      })
      if (remote.etag !== undefined) {
        // Is the gist still the one this round merged? GitHub doesn't count a 304 against its
        // rate limit. If another device pushed meanwhile, merge again: the library keeps this
        // round's merge, and the base stays, so the next round loses nothing.
        const check = await deps.github.getGist(gistId, {
          etag: remote.etag,
          ...(signal === undefined ? {} : { signal }),
        })
        if (!check.notModified) continue
      }
      let pushed: { gist: Gist; etag?: string }
      try {
        pushed = await upload(
          deps.github,
          gistId,
          encoded,
          new Set(remote.files),
          remote.parts,
          deps.maxRequestBytes ?? MAX_REQUEST_BYTES,
          deps.pause ?? sleep,
          signal,
        )
      } catch (error) {
        if (!(error instanceof GitHubError) || error.code !== 'invalid') throw error
        // GitHub refused the upload as it was: most likely another device's push changed the
        // gist under it (both deleted the same old parts). Read it again and merge again.
        refused = error
        continue
      }
      const written = {
        revision,
        ancestors: encoded.manifest.ancestors,
        parts: encoded.manifest.parts,
        files: Object.keys(pushed.gist.files),
      }
      await deps.bases.put(newBase(gistId, merged, written, pushed.etag, now()))
      report.gistUrl = pageOf(pushed.gist) ?? report.gistUrl
      report.pushed = true
      report.bytes = partsBytes(written.parts)
      return report
    }
    if (refused !== undefined) throw refused
    throw new SyncError('busy', 'The gist kept changing while this device synced')
  } catch (error) {
    throw toSyncError(error)
  }
}

/**
 * Rewrites a gist that can't be read (changed outside FXM) with this device's library. The
 * new revision has no ancestors on purpose: other devices then treat nothing the gist lacks
 * as deleted, merge their own libraries into it and push back what this device lacks.
 */
export async function rewriteSyncGist(
  deps: SyncDeps,
  gistId: string,
  signal?: AbortSignal,
): Promise<SyncReport> {
  const now = deps.now ?? Date.now
  try {
    const read = await deps.github.getGist(gistId, signal === undefined ? {} : { signal })
    if (read.notModified) throw new SyncError('failed', 'GitHub answered “not modified”')
    checkOwner(read.gist, deps.login)
    const snapshot = await localForGist(deps, now() - HISTORY_WINDOW_MS)
    const revision = (deps.revision ?? newRevision)()
    const encoded = encodeSnapshot(snapshot, { revision, ancestors: [], savedAt: new Date(now()) })
    const pushed = await upload(
      deps.github,
      gistId,
      encoded,
      new Set(Object.keys(read.gist.files)),
      [],
      deps.maxRequestBytes ?? MAX_REQUEST_BYTES,
      deps.pause ?? sleep,
      signal,
    )
    const parts = encoded.manifest.parts
    const files = Object.keys(pushed.gist.files)
    await deps.bases.put(
      newBase(gistId, snapshot, { revision, ancestors: [], parts, files }, pushed.etag, now()),
    )
    return {
      gistId,
      gistUrl: pageOf(pushed.gist) ?? gistPageUrl(deps.login, gistId),
      created: false,
      pulled: 0,
      pushed: true,
      copies: [],
      notices: [],
      skipped: 0,
      bytes: partsBytes(parts),
      deferred: false,
    }
  } catch (error) {
    throw toSyncError(error)
  }
}

// --- Setting sync up -------------------------------------------------------------------------

/** A sync gist found for an account, with what it holds. */
export interface FoundGist {
  gist: Gist
  manifest: SyncManifest
  snapshot: SyncSnapshot
}

/**
 * The account's sync gists, most recently updated first, from up to `maxPages` pages of its
 * gists. A fine-grained token may not list secret gists; then the user pastes the gist's link.
 */
export async function findSyncGists(
  github: GistApi,
  { maxPages = 10, signal }: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<Gist[]> {
  try {
    const found: Gist[] = []
    for (let page = 1; page <= maxPages; page++) {
      const { gists, hasMore } = await github.listGists(page, signal)
      found.push(...gists.filter((gist) => Object.hasOwn(gist.files, MANIFEST_FILE)))
      if (!hasMore) break
    }
    return found.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    )
  } catch (error) {
    throw toSyncError(error)
  }
}

/** Reads a sync gist of `login`'s, to show what it holds before joining it. */
export async function readSyncGist(
  github: GistApi,
  gistId: string,
  login: string,
  { signal, now = Date.now() }: { signal?: AbortSignal | undefined; now?: number } = {},
): Promise<FoundGist> {
  try {
    const read = await github.getGist(gistId, signal === undefined ? {} : { signal })
    if (read.notModified) throw new SyncError('failed', 'GitHub answered “not modified”')
    checkOwner(read.gist, login)
    const manifest = readManifest(read.gist)
    const { snapshot } = decodeSnapshot(manifest, (name) => read.gist.files[name])
    return {
      gist: read.gist,
      manifest,
      snapshot: withHistorySince(snapshot, now - HISTORY_WINDOW_MS),
    }
  } catch (error) {
    throw toSyncError(error)
  }
}
