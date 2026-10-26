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
 * Sync works only with a **secret** gist of the token's account. GitHub lets the owner make a
 * secret gist public (and never secret again), so every read and write checks: a public gist
 * stops sync with `public` until the user sets it up again with a new secret gist.
 *
 * When the gist lacks so much of this device's library that the merge would remove a lot here
 * (see `exceedsRemovalLimits`), the sync stops with `removals` before it changes anything, and
 * the user decides: remove it here too, or keep it and put it back in the gist.
 *
 * Plays sync for {@link HISTORY_WINDOW_MS} (90 days), and the gist carries only the track
 * metadata the rest uses (see `snapshot.ts`): GitHub sends the whole gist back after every
 * update, so it stays as small as it can.
 *
 * @module
 */

import type { JsonObject } from '@fxm/core'
import type { LibraryRepo } from '../../db/repo'
import { BASE_VERSION, type BaseStore, type SyncBase } from './base-store'
import { utf8Length } from './canonical'
import {
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  isPartFile,
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
import {
  type ConflictCopy,
  exceedsRemovalLimits,
  type MergeNotice,
  type RemovalCounts,
} from './merge'
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

/**
 * How long after its push a device takes a read of an older revision for GitHub's delay. Later,
 * the gist really went back (a revert of its Git history): the sync merges it like a gist that
 * doesn't descend from the base, and pushes again.
 */
export const STALE_READ_GRACE_MS = 10 * 60_000

/**
 * How long a part file that no manifest lists stays in the gist: another device's push may
 * still be uploading it. After that it is what a failed push left behind, and a push deletes it.
 */
export const STRAY_AGE_MS = 60 * 60_000

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
  /** The gist is public: listed on the profile and found by search engines. */
  | 'public'
  /** The gist was written by a newer FXM. */
  | 'too-new'
  /** The gist was changed outside FXM and can't be read. */
  | 'corrupt'
  /** The library doesn't fit in a gist. */
  | 'too-large'
  /** The gist lacks much of this device's library: the user decides (see `removed`). */
  | 'removals'
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
  /** For `removals`: what the merge would remove here. */
  readonly removed: RemovalCounts | undefined

  constructor(
    code: SyncErrorCode,
    message: string,
    options: {
      retryAfterMs?: number | undefined
      detail?: string | undefined
      removed?: RemovalCounts | undefined
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryAfterMs = options.retryAfterMs
    this.detail = options.detail
    this.removed = options.removed
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

/**
 * Refuses a public gist. GitHub lets its owner make a secret gist public with one edit, and
 * never secret again; sync then stops rather than publish the library and its history.
 */
function checkSecret(gist: Gist): void {
  if (gist.public) throw new SyncError('public', 'The gist is public')
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
 * The part files in `files` that neither list of a manifest names, with when this device first
 * saw each: as `seen` says, 0 for one a manifest this device knew listed (`known`: nobody waits
 * for it), and `now` for a new one.
 */
function straysOf(
  files: readonly string[],
  listed: { parts: readonly PartRef[]; previous: readonly string[] },
  seen: Readonly<Record<string, number>>,
  known: ReadonlySet<string>,
  now: number,
): Record<string, number> {
  const named = new Set([...listed.parts.map((part) => part.file), ...listed.previous])
  const strays: Record<string, number> = {}
  for (const file of files) {
    if (!isPartFile(file) || named.has(file)) continue
    strays[file] = known.has(file) ? 0 : (seen[file] ?? now)
  }
  return strays
}

/** What an upload may do to the files of the gist. */
interface UploadPlan {
  /** Every file the gist holds. */
  existing: ReadonlySet<string>
  /**
   * The parts of the manifest this push replaces. They stay, one push longer, and aren't
   * uploaded again: only they are sure to stay while another device pushes too.
   */
  kept: ReadonlySet<string>
  /** Files the push may delete, unless its manifest lists them. */
  deletable: ReadonlySet<string>
}

/**
 * Uploads an encoded snapshot: new parts first (in several requests if they are large), then
 * the manifest, as the last request. Until then, readers keep reading the old manifest's parts.
 *
 * - The parts of the manifest it replaces stay, one push longer: if another device's push lands
 *   between this device's last check and its upload, either manifest that ends up in the gist
 *   still finds all its parts. Every other part goes up, even if the gist holds a file of that
 *   name already: it may be about to go.
 * - It deletes only `deletable` files: parts of manifests before, and files no manifest lists
 *   that have been there for {@link STRAY_AGE_MS}. A file no manifest lists may be another
 *   device's push still going up, so it stays until then. The deletions go with the manifest.
 */
async function upload(
  github: GistApi,
  gistId: string,
  encoded: EncodedSnapshot,
  plan: UploadPlan,
  maxRequestBytes: number,
  pause: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<{ gist: Gist; etag?: string }> {
  const uploads = [...encoded.parts].filter(([file]) => !plan.kept.has(file))
  const deletions = [...plan.deletable].filter(
    (file) =>
      plan.existing.has(file) &&
      isPartFile(file) &&
      !encoded.parts.has(file) &&
      !plan.kept.has(file),
  )
  const groups = batches(uploads, maxRequestBytes - utf8Length(encoded.manifestText))
  for (const group of groups.slice(0, -1)) {
    const result = await write(() => github.updateGist(gistId, Object.fromEntries(group), signal))
    checkSecret(result.gist)
    await pause(WRITE_SPACING_MS)
  }
  const last: Record<string, string | null> = Object.fromEntries(groups.at(-1) ?? [])
  for (const file of deletions) last[file] = null
  last[MANIFEST_FILE] = encoded.manifestText
  const result = await write(() => github.updateGist(gistId, last, signal))
  checkSecret(result.gist)
  return result
}

/** The gist as one sync round sees it. */
interface RemoteState {
  /** Its library, with the plays of the history window. */
  snapshot: SyncSnapshot
  revision: string
  ancestors: string[]
  parts: PartRef[]
  /** The parts of the manifest it replaced that the gist still holds. */
  previous: string[]
  /** Every file name in the gist. */
  files: string[]
  /** Part files neither list names, with when this device first saw each. */
  strays: Record<string, number>
  /** The start of its writer's history window, when the manifest says. */
  historySince: number | undefined
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
  now: number,
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
      previous: base.previous,
      files: base.files,
      strays: base.strays,
      historySince: undefined,
      etag: read.etag ?? base.etag,
      url: undefined,
      fromBase: true,
      stale: false,
      skipped: 0,
    }
  }
  const { gist } = read
  checkOwner(gist, deps.login)
  checkSecret(gist)
  const manifest = readManifest(gist)
  const files = Object.keys(gist.files)
  const known = new Set(
    base === undefined ? [] : [...base.parts.map((part) => part.file), ...base.previous],
  )
  const shared = {
    revision: manifest.revision,
    ancestors: manifest.ancestors,
    parts: manifest.parts,
    previous: manifest.previous,
    files,
    strays: straysOf(files, manifest, base?.strays ?? {}, known, now),
    historySince: manifest.historySince,
    etag: read.etag,
    url: pageOf(gist),
  }
  if (base !== undefined && manifest.revision === base.revision) {
    // Only the gist's metadata changed (or its ETag): its library is the base.
    const snapshot = withHistorySince(base.snapshot, historySince)
    return { ...shared, snapshot, fromBase: true, stale: false, skipped: 0 }
  }
  if (base?.ancestors.includes(manifest.revision) && now - base.savedAt < STALE_READ_GRACE_MS) {
    return { ...shared, snapshot: base.snapshot, fromBase: true, stale: true, skipped: 0 }
  }
  // A gist that went back to a revision before the base, long after this device's push, is
  // merged like one that doesn't descend from the base: nothing it lacks counts as deleted.
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

/** What a base says about the gist besides its library. */
interface GistState {
  revision: string
  ancestors: string[]
  parts: PartRef[]
  previous: string[]
  files: string[]
  strays: Record<string, number>
}

/** The base after writing `snapshot` (already in its gist form) as `written`. */
function newBase(
  gistId: string,
  snapshot: SyncSnapshot,
  written: GistState,
  etag: string | undefined,
  now: number,
): SyncBase {
  const base: SyncBase = {
    version: BASE_VERSION,
    gistId,
    revision: written.revision,
    ancestors: written.ancestors,
    snapshot,
    fingerprint: snapshotFingerprint(snapshot),
    parts: written.parts,
    previous: written.previous,
    files: written.files,
    strays: written.strays,
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
    const historySince = now() - HISTORY_WINDOW_MS
    const snapshot = await localForGist(deps, historySince)
    const revision = (deps.revision ?? newRevision)()
    const encoded = encodeSnapshot(snapshot, {
      revision,
      ancestors: [],
      savedAt: new Date(now()),
      historySince,
    })
    const budget = deps.maxRequestBytes ?? MAX_REQUEST_BYTES
    const groups = batches([...encoded.parts], budget - utf8Length(encoded.manifestText))
    const first: Record<string, string> = Object.fromEntries(groups[0] ?? [])
    if (groups.length <= 1) first[MANIFEST_FILE] = encoded.manifestText
    let result = await write(() =>
      deps.github.createGist({ description: GIST_DESCRIPTION, files: first }, signal),
    )
    const gistId = result.gist.id
    try {
      checkSecret(result.gist)
      for (const [index, group] of groups.slice(1).entries()) {
        await (deps.pause ?? sleep)(WRITE_SPACING_MS)
        const body: Record<string, string> = Object.fromEntries(group)
        if (index === groups.length - 2) body[MANIFEST_FILE] = encoded.manifestText
        result = await write(() => deps.github.updateGist(gistId, body, signal))
        checkSecret(result.gist)
      }
    } catch (error) {
      // A large library goes up in several requests, the manifest last. Don't leave a gist
      // without one behind: nothing could find or use it. And a gist that came out public
      // goes at once.
      await deps.github.deleteGist(gistId).catch(() => {})
      throw error
    }
    const parts = encoded.manifest.parts
    const files = Object.keys(result.gist.files)
    await deps.bases.put(
      newBase(
        gistId,
        snapshot,
        {
          revision,
          ancestors: [],
          parts,
          previous: [],
          files,
          strays: straysOf(files, encoded.manifest, {}, new Set(), now()),
        },
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

/** What a sync does when the gist lacks much of this device's library. */
export type RemovalChoice =
  /** Stop with `removals`, before changing anything, so the user decides. */
  | 'ask'
  /** Remove it here too. */
  | 'apply'
  /** Keep it, and put it back in the gist, so the other devices get it back too. */
  | 'keep'

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
  /**
   * What to do when the merge would remove much of this device's library (see
   * `exceedsRemovalLimits`). Default: `ask`. `keep` keeps everything the gist lacks, small
   * removals included.
   */
  removals?: RemovalChoice
}

/** Stops a merge that would remove much of this device's library, before it writes anything. */
function askBeforeRemoving(removed: RemovalCounts, local: SyncSnapshot): void {
  if (exceedsRemovalLimits(removed, local)) {
    throw new SyncError('removals', 'The gist lacks much of this device’s library', { removed })
  }
}

/** Syncs the library with its gist (see the module documentation). */
export async function syncLibrary(
  deps: SyncDeps,
  gistId: string,
  options: SyncOptions = {},
): Promise<SyncReport | null> {
  const { signal, pushBackground = true, removals = 'ask' } = options
  const now = deps.now ?? Date.now
  const historySince = now() - HISTORY_WINDOW_MS
  try {
    const stored = await deps.bases.get(gistId)
    const base =
      stored === undefined
        ? undefined
        : { ...stored, snapshot: withHistorySince(stored.snapshot, historySince) }
    if (options.skipIfUnchanged && stored !== undefined && base !== undefined) {
      const local = await localForGist(deps, historySince)
      const agreed =
        base.snapshot === stored.snapshot ? stored.fingerprint : snapshotFingerprint(base.snapshot)
      if (snapshotFingerprint(local) === agreed) return null
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
      const remote = await readRemote(deps, gistId, base, historySince, now(), signal)
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
        // To keep what the gist lacks, nothing it lacks may count as deleted.
        remoteFromBase: remote.fromBase && removals !== 'keep',
        appSettings: deps.appSettings.read(),
        appSettingsDefaults: deps.appSettings.defaults,
        historySince,
        // A play the gist lacks counts as deleted only inside its writer's window: older ones
        // fell out of it. Gists of an earlier FXM don't say, so near the window's start none do.
        historyDeletionsSince: remote.historySince ?? historySince + HISTORY_EDGE_MS,
        ...(removals === 'ask' ? { checkRemovals: askBeforeRemoving } : {}),
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
      const kept = new Set(remote.parts.map((part) => part.file))
      const encoded = encodeSnapshot(merged, {
        revision,
        ancestors: lineage(remote, base),
        savedAt: new Date(now()),
        historySince,
        previous: [...kept],
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
      const time = now()
      const expired = Object.entries(remote.strays).filter(
        ([, since]) => time - since >= STRAY_AGE_MS,
      )
      let pushed: { gist: Gist; etag?: string }
      try {
        pushed = await upload(
          deps.github,
          gistId,
          encoded,
          {
            existing: new Set(remote.files),
            kept,
            deletable: new Set([...remote.previous, ...expired.map(([file]) => file)]),
          },
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
      const files = Object.keys(pushed.gist.files)
      const written: GistState = {
        revision,
        ancestors: encoded.manifest.ancestors,
        parts: encoded.manifest.parts,
        previous: encoded.manifest.previous,
        files,
        strays: straysOf(files, encoded.manifest, remote.strays, new Set(), time),
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
    checkSecret(read.gist)
    const historySince = now() - HISTORY_WINDOW_MS
    const snapshot = await localForGist(deps, historySince)
    const revision = (deps.revision ?? newRevision)()
    const encoded = encodeSnapshot(snapshot, {
      revision,
      ancestors: [],
      savedAt: new Date(now()),
      historySince,
    })
    const existing = new Set(Object.keys(read.gist.files))
    const pushed = await upload(
      deps.github,
      gistId,
      encoded,
      // The gist can't be read: every part goes up again, and every other part file goes.
      { existing, kept: new Set(), deletable: existing },
      deps.maxRequestBytes ?? MAX_REQUEST_BYTES,
      deps.pause ?? sleep,
      signal,
    )
    const parts = encoded.manifest.parts
    const files = Object.keys(pushed.gist.files)
    await deps.bases.put(
      newBase(
        gistId,
        snapshot,
        {
          revision,
          ancestors: [],
          parts,
          previous: [],
          files,
          strays: straysOf(files, encoded.manifest, {}, new Set(), now()),
        },
        pushed.etag,
        now(),
      ),
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

/**
 * Deletes the sync gist from GitHub, with every earlier version of it. A gist that is gone
 * already counts as deleted; one of another account is refused (`not-owner`).
 */
export async function deleteSyncGist(
  github: GistApi,
  gistId: string,
  login: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    let read: Awaited<ReturnType<GistApi['getGist']>>
    try {
      read = await github.getGist(gistId, signal === undefined ? {} : { signal })
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'not-found') return
      throw error
    }
    if (!read.notModified) checkOwner(read.gist, login)
    await write(() => github.deleteGist(gistId, signal))
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
 * The account's secret sync gists, most recently updated first, from up to `maxPages` pages of
 * its gists. Public ones are left out: sync never uses one. A fine-grained token may not list
 * secret gists; then the user pastes the gist's link.
 */
export async function findSyncGists(
  github: GistApi,
  { maxPages = 10, signal }: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<Gist[]> {
  try {
    const found: Gist[] = []
    for (let page = 1; page <= maxPages; page++) {
      const { gists, hasMore } = await github.listGists(page, signal)
      found.push(
        ...gists.filter((gist) => !gist.public && Object.hasOwn(gist.files, MANIFEST_FILE)),
      )
      if (!hasMore) break
    }
    return found.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    )
  } catch (error) {
    throw toSyncError(error)
  }
}

/** Reads a secret sync gist of `login`'s, to show what it holds before joining it. */
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
    checkSecret(read.gist)
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
