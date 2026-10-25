/**
 * The updater of the desktop and Android apps: on start it restores the last good version of
 * each artifact (verified again), then fetches newer signed versions from FXM's static site,
 * trying each URL of a list in turn. Whatever goes wrong (an unreachable host, a bad signature,
 * an older version, a module that doesn't load), the app keeps what it has: the last good
 * version, or the copy it ships with.
 *
 * - **Signatures.** Every artifact needs a signature file by a key compiled into the build
 *   (`update-keys.json`); with no real key there, nothing is fetched or accepted.
 * - **Versions only increase.** A version replaces the one in use only when it is higher, and
 *   never when it is lower than the highest version this device ever accepted from a key the
 *   build still trusts (the floor, kept even when the stored copy is lost).
 * - **Bad and revoked versions.** A validly signed version that fails to load is remembered and
 *   never downloaded again until the next app update; the next higher version is. Versions the
 *   build lists as revoked are refused.
 * - **F-Droid builds** download and load code only after the user's opt-in.
 *
 * The web app doesn't use the updater: it gets new code and config by redeploy.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import { type Clock, systemClock } from '../clock.ts'
import type { NativeHttp } from '../native.ts'
import { type KeyValueStorage, readJson, writeJson } from '../storage.ts'
import type { UpdateArtifact, UpdateOrigin, VersionInUse } from './artifact.ts'
import { concatBytes } from './encoding.ts'
import {
  MAX_SIGNATURE_BYTES,
  MAX_VERSION,
  parseEnvelope,
  parseStatement,
  SIGNATURE_SUFFIX,
  type UpdateStatement,
} from './format.ts'
import { checkTrustedKeys, type RevokedVersions, UPDATE_SIGNING_KEYS } from './keys.ts'
import { type Distribution, updatePolicy } from './policy.ts'
import type { StoredUpdate, UpdateStore } from './store.ts'
import {
  type ArtifactExpectation,
  checkArtifactBytes,
  createSignatureVerifier,
  type SignatureVerifier,
  type TrustedKey,
  type VerificationError,
  type VerificationFailure,
  verifySignatureFile,
} from './verify.ts'

/**
 * Where FXM publishes signed updates: the `/updates/` folder of the static site. A stage that
 * renames the site changes it here.
 */
export const DEFAULT_UPDATE_BASE_URLS: readonly string[] = ['https://fxmusic.pages.dev/updates/']

/** The request the updater makes: a plain GET, without credentials, that follows no redirect. */
export interface UpdateRequestInit {
  /** Always `GET`. */
  readonly method: 'GET'
  /** Always `omit`. */
  readonly credentials: 'omit'
  /** Always `error`: the URL list names the files themselves. */
  readonly redirect: 'error'
  /** Cancels the request: on a timeout, or when the caller cancels the check. */
  readonly signal: AbortSignal
}

/**
 * Fetches one update file. On desktop and Android it wraps the native HTTP of stages 7.2 and
 * 6.2 ({@link updateFetchFromNative}), whose host allow-list must include the update URLs.
 */
export type UpdateFetch = (url: string, init: UpdateRequestInit) => Promise<Response>

/** An {@link UpdateFetch} over a platform's native HTTP: a GET with no `Origin` header. */
export function updateFetchFromNative(http: NativeHttp): UpdateFetch {
  return (url, init) =>
    http(url, {
      method: 'GET',
      headers: { origin: '' },
      signal: init.signal,
      redirect: init.redirect,
    })
}

/** Why something went wrong while restoring or checking an artifact. */
export type UpdateProblemReason =
  | VerificationFailure
  /** The request failed: no network, DNS, TLS, a refused redirect. */
  | 'unreachable'
  /** The site answered with an HTTP error, such as 404 before anything is published. */
  | 'http-error'
  /** The request took too long. */
  | 'timeout'
  /** A validly signed version below the highest this device ever accepted. */
  | 'rollback'
  /** A version this build lists as revoked (`update-keys.json`). */
  | 'revoked'
  /** A version that failed to load before, which is not tried again until an app update. */
  | 'known-bad'
  /** A verified version that failed to load or that the artifact refused; it is remembered. */
  | 'load-failed'
  /**
   * A verified version this app can't use now, through no fault of its own, such as a config
   * that the module in use can't read. It is not remembered: a later check tries again.
   */
  | 'unusable'
  /** This platform can't load downloaded code at all, e.g. its CSP has no `blob:` in `script-src`. */
  | 'code-unsupported'
  /** The last good version, or the floors and bad versions, could not be read or saved. */
  | 'store-failed'
  /** This build trusts no signing key (the placeholder), so it accepts no update. */
  | 'no-key'
  /** Code updates wait for the user's opt-in (F-Droid builds). */
  | 'needs-opt-in'

/** One thing that went wrong. */
export interface UpdateProblem {
  /** Why. */
  readonly reason: UpdateProblemReason
  /** Details, for logs and Diagnostics. */
  readonly message: string
  /** The URL involved, if any. */
  readonly url?: string
  /** The version involved, if known. */
  readonly version?: number
}

/**
 * The result for one artifact:
 *
 * - `updated`: a newer version was verified, loaded and is now in use;
 * - `current`: nothing newer was found, and what is in use stays;
 * - `skipped`: not checked: the build trusts no key, code updates wait for the opt-in, or the
 *   platform can't load code;
 * - `failed`: no URL gave a usable answer (`problems` says why); what is in use stays.
 */
export type ArtifactOutcome = 'updated' | 'current' | 'skipped' | 'failed'

/** What happened to one artifact. */
export interface ArtifactReport {
  /** The artifact's kind. */
  readonly kind: string
  /** The outcome. */
  readonly outcome: ArtifactOutcome
  /** The version in use afterwards. */
  readonly version: number
  /** Where it came from. */
  readonly origin: UpdateOrigin
  /** What went wrong on the way, in order. Problems don't stop the app: it keeps a version. */
  readonly problems: readonly UpdateProblem[]
}

/** What a restore or check did, artifact by artifact. */
export interface UpdateReport {
  /** One report per artifact, in the order the updater was given them. */
  readonly artifacts: readonly ArtifactReport[]
}

/** The state of one artifact, for Diagnostics. */
export interface ArtifactStatus {
  /** The kind. */
  readonly kind: string
  /** The version in use. */
  readonly version: number
  /** Where it came from. */
  readonly origin: UpdateOrigin
  /**
   * The highest version this device accepted from a key the build trusts; versions below it are
   * refused.
   */
  readonly floor: number
  /** The versions that failed to load since the last app update, which are not tried again. */
  readonly bad: readonly number[]
  /** The last check, if any. */
  readonly lastCheck?: { readonly at: number; readonly outcome: ArtifactOutcome }
}

/** Options for {@link createUpdater}. */
export interface UpdaterOptions {
  /**
   * The artifacts, in the order they are restored and checked: put code before the data it
   * reads, so that a new config is checked by the newest module.
   */
  readonly artifacts: readonly UpdateArtifact[]
  /** Fetches update files. */
  readonly fetch: UpdateFetch
  /**
   * Where the update files are, tried in order: each URL is a folder (it ends in `/`) holding
   * `<file>` and `<file>.sig`. HTTPS only, except `http://localhost` and `http://127.0.0.1` for
   * development. Default {@link DEFAULT_UPDATE_BASE_URLS}.
   */
  readonly baseUrls?: readonly string[]
  /**
   * Where the last good versions are kept: `indexedDbUpdateStore()` in the apps,
   * `memoryUpdateStore()` in tests.
   */
  readonly store: UpdateStore
  /**
   * Where the floors and bad versions are kept: `localStorage` in the apps, `memoryStorage()` in
   * tests. Required, because rollback protection rests on it: without it, every restart would
   * forget the highest versions accepted, and an older signed version could come back.
   */
  readonly state: KeyValueStorage
  /**
   * The trusted public keys. Default: the ones compiled into the build.
   *
   * @throws FxmError `Unsupported` (from {@link createUpdater}) for a key that is not a valid
   * Ed25519 public key under its own ID.
   */
  readonly keys?: readonly TrustedKey[]
  /** The revoked versions, per kind. Default: the ones compiled into the build. */
  readonly revoked?: RevokedVersions
  /** Checks signatures. Default: WebCrypto's Ed25519 where it works, else `@noble/curves`. */
  readonly verifier?: SignatureVerifier
  /** The build's distribution, which decides whether code waits for an opt-in. */
  readonly distribution?: Distribution
  /**
   * Whether code may be downloaded and loaded, read at every restore and check. Default: always
   * in standard builds, never in F-Droid builds. F-Droid builds pass the user's opt-in.
   */
  readonly allowCode?: () => boolean
  /** How long a signature file may take, in milliseconds. Default 15 s. */
  readonly signatureTimeoutMs?: number
  /** How long an artifact may take, in milliseconds. Default 60 s. */
  readonly artifactTimeoutMs?: number
  /** The clock, for timeouts and status times. */
  readonly clock?: Clock
}

/** Options for {@link Updater.check}. */
export interface UpdateCheckOptions {
  /**
   * Cancels this caller's wait: its promise rejects with the signal's reason, and what is in use
   * stays. The check itself stops only once every caller waiting for it has cancelled.
   */
  readonly signal?: AbortSignal
}

/**
 * Keeps the signed artifacts of a desktop or Android app current. Its calls run one at a time,
 * in the order they are made, so a restore never undoes a check that is under way.
 */
export interface Updater {
  /**
   * Switches each artifact to its last good stored version, verified again, or else to the copy
   * the app ships with. Makes no request. Call it once at start; calling it again changes only
   * what the F-Droid opt-in changed since.
   */
  restore(): Promise<UpdateReport>
  /**
   * Looks for newer signed versions at each URL in turn and switches to them. Never throws for
   * network or verification problems: they are in the report. Concurrent calls share one check.
   *
   * @throws The reason of `options.signal` when it cancels the wait (see
   * {@link UpdateCheckOptions.signal}).
   */
  check(options?: UpdateCheckOptions): Promise<UpdateReport>
  /** {@link restore}, then {@link check}; the report has the problems of both. */
  start(options?: UpdateCheckOptions): Promise<UpdateReport>
  /** Each artifact's state. */
  status(): readonly ArtifactStatus[]
}

/** The storage key of the floors and bad versions. */
export const UPDATE_STATE_KEY = 'fxm.updates.v1'

/** How many bad versions are remembered per kind. */
const MAX_BAD_VERSIONS = 20

/** What is kept per kind across restarts. */
interface PersistedKind {
  /** The highest version accepted from each signing key, by key ID. */
  readonly floors: ReadonlyMap<string, number>
  /** Versions that failed to load. */
  readonly bad: readonly number[]
  /** The version the app shipped with when they failed: an app update gives them a new chance. */
  readonly badFor: number
}

/** What the updater knows about an artifact while it runs. */
interface Runtime {
  /** The version the updater last switched the artifact to. */
  activated: VersionInUse
  lastCheck?: { at: number; outcome: ArtifactOutcome }
}

/** What became of a stored copy at restore. */
type RestoreResult = 'used' | 'dropped' | 'kept'

/** A failed download, with the reason for the report. */
class DownloadProblem extends Error {
  override readonly name = 'DownloadProblem'
  readonly reason: UpdateProblemReason

  constructor(reason: UpdateProblemReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/** Checks an update URL and returns it as a folder URL that ends in `/`. */
export function normalizeUpdateBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new FxmError('Unsupported', `Not an update URL: ${input}`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
  if (
    !scheme ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new FxmError(
      'Unsupported',
      `Update URLs must be plain HTTPS folders (http only for localhost): ${input}`,
    )
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.href
}

function isVersion(value: unknown, min = 1): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= MAX_VERSION
}

/** The persisted entry of one kind, or `undefined` when there is none or it is not valid. */
function readPersisted(value: unknown): PersistedKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { floors, bad, badFor } = value as { floors?: unknown; bad?: unknown; badFor?: unknown }
  if (typeof floors !== 'object' || floors === null || Array.isArray(floors)) return undefined
  if (!Array.isArray(bad) || !bad.every((version) => isVersion(version))) return undefined
  if (!isVersion(badFor, 0)) return undefined
  const entries = Object.entries(floors)
  if (!entries.every(([, floor]) => isVersion(floor, 0))) return undefined
  return { floors: new Map(entries as [string, number][]), bad, badFor }
}

/** Both entries in one: the higher floor per key, and the bad versions of this app version. */
function combine(
  entries: readonly (PersistedKind | undefined)[],
  bundledVersion: number,
): PersistedKind {
  const floors = new Map<string, number>()
  const bad = new Set<number>()
  for (const entry of entries) {
    if (entry === undefined) continue
    for (const [keyId, floor] of entry.floors)
      floors.set(keyId, Math.max(floors.get(keyId) ?? 0, floor))
    if (entry.badFor === bundledVersion) for (const version of entry.bad) bad.add(version)
  }
  return { floors, bad: [...bad].slice(-MAX_BAD_VERSIONS), badFor: bundledVersion }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The version a stored copy's statement names, read without verifying it. */
function storedVersion(stored: StoredUpdate): number | undefined {
  try {
    return parseStatement(parseEnvelope(stored.envelope).statementBytes).version
  } catch {
    return undefined
  }
}

/**
 * Creates the updater for a desktop or Android app.
 *
 * ```ts
 * const updater = createUpdater({
 *   artifacts: [codeArtifact(youtube.updates.module), jsonArtifact(youtube.updates.config)],
 *   fetch: updateFetchFromNative(nativeHttp),
 *   store: indexedDbUpdateStore(),
 *   state: localStorage,
 *   distribution,
 * })
 * const report = await updater.start()
 * ```
 *
 * @throws FxmError `Unsupported` for an update URL that is not a plain HTTPS folder, a key that
 * is not a valid Ed25519 public key under its own ID, an artifact listed twice, or a missing
 * `store` or `state`.
 */
export function createUpdater(options: UpdaterOptions): Updater {
  const { artifacts, store, state } = options
  if (store === undefined || state === undefined) {
    throw new FxmError('Unsupported', 'The updater needs a store and a state storage')
  }
  const baseUrls = (options.baseUrls ?? DEFAULT_UPDATE_BASE_URLS).map(normalizeUpdateBaseUrl)
  const keys = options.keys ?? UPDATE_SIGNING_KEYS.keys
  checkTrustedKeys(keys)
  const revoked = options.revoked ?? UPDATE_SIGNING_KEYS.revoked
  const verifier = options.verifier ?? createSignatureVerifier()
  const clock = options.clock ?? systemClock
  const policy = updatePolicy(options.distribution ?? 'standard')
  const allowCode = options.allowCode ?? (() => !policy.codeNeedsOptIn)
  const signatureTimeoutMs = options.signatureTimeoutMs ?? 15_000
  const artifactTimeoutMs = options.artifactTimeoutMs ?? 60_000
  const kinds = new Set<string>()
  for (const artifact of artifacts) {
    if (kinds.has(artifact.kind))
      throw new FxmError('Unsupported', `${artifact.kind} is listed twice`)
    kinds.add(artifact.kind)
  }
  const runtime = new Map<string, Runtime>(
    artifacts.map((artifact) => [
      artifact.kind,
      { activated: { version: artifact.bundledVersion, origin: 'bundled' } },
    ]),
  )
  /** What this session saved, consulted with storage, so a failed write loses nothing until exit. */
  const memory = new Map<string, PersistedKind>()

  // --- One call at a time -------------------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve()

  function serially<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  // --- Persisted floors and bad versions ---------------------------------------------------

  function stored(kind: string): PersistedKind | undefined {
    const all = readJson(state, UPDATE_STATE_KEY)
    if (typeof all !== 'object' || all === null || !Object.hasOwn(all, kind)) return undefined
    return readPersisted((all as Record<string, unknown>)[kind])
  }

  function persisted(artifact: UpdateArtifact): PersistedKind {
    return combine([stored(artifact.kind), memory.get(artifact.kind)], artifact.bundledVersion)
  }

  /** Saves an entry, merged with what storage holds; a failed write goes to `problems`. */
  function persist(artifact: UpdateArtifact, entry: PersistedKind, problems: UpdateProblem[]) {
    memory.set(artifact.kind, entry)
    const all = readJson(state, UPDATE_STATE_KEY)
    const next: Record<string, unknown> =
      typeof all === 'object' && all !== null && !Array.isArray(all)
        ? { ...(all as Record<string, unknown>) }
        : {}
    const merged = combine([stored(artifact.kind), entry], artifact.bundledVersion)
    next[artifact.kind] = {
      floors: Object.fromEntries(merged.floors),
      bad: merged.bad,
      badFor: merged.badFor,
    }
    if (!writeJson(state, UPDATE_STATE_KEY, next)) {
      problems.push({
        reason: 'store-failed',
        message: `The floors and bad versions of ${artifact.kind} could not be saved: they hold until the app closes`,
      })
    }
  }

  /** The highest version accepted from a key the build still trusts. */
  function floorOf(entry: PersistedKind): number {
    return keys.reduce((floor, key) => Math.max(floor, entry.floors.get(key.keyId) ?? 0), 0)
  }

  function raiseFloor(
    artifact: UpdateArtifact,
    keyId: string,
    version: number,
    problems: UpdateProblem[],
  ) {
    const entry = persisted(artifact)
    if (version <= (entry.floors.get(keyId) ?? 0)) return
    persist(artifact, { ...entry, floors: new Map(entry.floors).set(keyId, version) }, problems)
  }

  function markBad(artifact: UpdateArtifact, version: number, problems: UpdateProblem[]) {
    const entry = persisted(artifact)
    if (entry.bad.includes(version)) return
    persist(artifact, { ...entry, bad: [...entry.bad, version].slice(-MAX_BAD_VERSIONS) }, problems)
  }

  function isRevoked(artifact: UpdateArtifact, version: number): boolean {
    const versions = Object.hasOwn(revoked, artifact.kind) ? revoked[artifact.kind] : undefined
    return versions?.includes(version) ?? false
  }

  // --- Helpers --------------------------------------------------------------------------------

  function expectationOf(artifact: UpdateArtifact): ArtifactExpectation {
    return {
      kind: artifact.kind,
      file: artifact.file,
      maxBytes: artifact.maxBytes,
      ...(artifact.api === undefined ? {} : { api: artifact.api }),
    }
  }

  function runtimeOf(artifact: UpdateArtifact): Runtime {
    return runtime.get(artifact.kind) as Runtime
  }

  /** The version in use: as the artifact reports it, else the one the updater switched to. */
  function inUse(artifact: UpdateArtifact): VersionInUse {
    try {
      const reported = artifact.inUse?.()
      if (reported !== undefined && isVersion(reported.version)) return reported
    } catch {
      // The artifact's own bookkeeping failed: fall back to the updater's.
    }
    return runtimeOf(artifact).activated
  }

  function report(
    artifact: UpdateArtifact,
    outcome: ArtifactOutcome,
    problems: readonly UpdateProblem[],
  ): ArtifactReport {
    const { version, origin } = inUse(artifact)
    return { kind: artifact.kind, outcome, version, origin, problems }
  }

  function setActivated(artifact: UpdateArtifact, activated: VersionInUse): void {
    runtime.set(artifact.kind, { ...runtimeOf(artifact), activated })
  }

  function useBundled(artifact: UpdateArtifact): void {
    artifact.useBundled()
    setActivated(artifact, { version: artifact.bundledVersion, origin: 'bundled' })
  }

  async function forget(artifact: UpdateArtifact, problems: UpdateProblem[]): Promise<void> {
    try {
      await store.delete(artifact.kind)
    } catch (error) {
      problems.push({ reason: 'store-failed', message: messageOf(error) })
    }
  }

  /**
   * Loads and activates a verified artifact. Returns `undefined` when it is in use, else the
   * problem: a failed load is remembered as bad, an `Unsupported` refusal is not.
   */
  async function activate(
    artifact: UpdateArtifact,
    bytes: Uint8Array<ArrayBuffer>,
    statement: UpdateStatement,
    keyId: string,
    origin: 'stored' | 'fetched',
    problems: UpdateProblem[],
  ): Promise<UpdateProblem | undefined> {
    const { version } = statement
    try {
      const value = await artifact.load(bytes, statement)
      artifact.activate(value, { origin, version })
    } catch (error) {
      if (isFxmError(error, 'Unsupported')) {
        return {
          reason: 'unusable',
          message: `Version ${version} of ${artifact.kind} can't be used now: ${messageOf(error)}`,
          version,
        }
      }
      markBad(artifact, version, problems)
      return {
        reason: 'load-failed',
        message: `Version ${version} of ${artifact.kind} can't be used: ${messageOf(error)}`,
        version,
      }
    }
    setActivated(artifact, { version, origin })
    raiseFloor(artifact, keyId, version, problems)
    return undefined
  }

  /** Downloads a file of at most `maxBytes`, within `timeoutMs`. */
  async function download(
    url: string,
    maxBytes: number,
    timeoutMs: number,
    outer: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = clock.setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The update request timed out', 'TimeoutError'))
    }, timeoutMs)
    const onAbort = () => controller.abort(outer.reason)
    outer.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok)
        throw new DownloadProblem('http-error', `HTTP ${response.status} for ${url}`)
      const declared = Number(response.headers.get('content-length') ?? Number.NaN)
      if (declared > maxBytes) throw new DownloadProblem('too-large', `${url} is too large`)
      const reader = response.body?.getReader()
      if (reader === undefined) {
        const whole = new Uint8Array(await response.arrayBuffer())
        if (whole.length > maxBytes) throw new DownloadProblem('too-large', `${url} is too large`)
        return whole
      }
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new DownloadProblem('too-large', `${url} is larger than expected`)
        }
        chunks.push(value)
      }
      return concatBytes(...chunks)
    } catch (error) {
      if (outer.aborted) throw outer.reason
      if (error instanceof DownloadProblem) throw error
      if (timedOut) throw new DownloadProblem('timeout', `${url} took longer than ${timeoutMs} ms`)
      throw new DownloadProblem('unreachable', `${url} could not be fetched: ${messageOf(error)}`)
    } finally {
      clock.clearTimeout(timer)
      outer.removeEventListener('abort', onAbort)
    }
  }

  function codeAllowed(artifact: UpdateArtifact): boolean {
    if (!artifact.executable) return true
    try {
      return allowCode()
    } catch {
      return false
    }
  }

  /** Whether the platform can load the artifact at all (code only; asked once per session). */
  async function loadable(artifact: UpdateArtifact): Promise<boolean> {
    if (artifact.canLoad === undefined) return true
    try {
      return await artifact.canLoad()
    } catch {
      return false
    }
  }

  const optInProblem: UpdateProblem = {
    reason: 'needs-opt-in',
    message: 'Downloaded code is off until the user turns it on',
  }

  const codeProblem: UpdateProblem = {
    reason: 'code-unsupported',
    message: 'This platform can’t load downloaded code (no blob: modules, or its CSP forbids them)',
  }

  // --- A version that fails in use --------------------------------------------------------------

  /** A version the artifact switched away from because it failed at first use. */
  function failedInUse(artifact: UpdateArtifact, version: number): Promise<void> {
    return serially(async () => {
      markBad(artifact, version, [])
      if (runtimeOf(artifact).activated.version === version) {
        setActivated(artifact, { version: artifact.bundledVersion, origin: 'bundled' })
      }
      try {
        const kept = await store.get(artifact.kind)
        if (kept !== undefined && storedVersion(kept) === version) await store.delete(artifact.kind)
      } catch {
        // The stored copy stays; it is refused as known-bad when it is next restored.
      }
    })
  }

  for (const artifact of artifacts) {
    artifact.watch?.((version) => {
      if (isVersion(version)) void failedInUse(artifact, version)
    })
  }

  // --- Restore --------------------------------------------------------------------------------

  /** Switches to the stored copy of an artifact, if it is still good. */
  async function restoreStored(
    artifact: UpdateArtifact,
    kept: StoredUpdate,
    problems: UpdateProblem[],
  ): Promise<RestoreResult> {
    const verdict = await verifySignatureFile(
      kept.envelope,
      expectationOf(artifact),
      keys,
      verifier,
    )
    const failure = verdict.ok ? checkArtifactBytes(kept.bytes, verdict.statement) : verdict
    if (!verdict.ok || failure !== undefined) {
      const { failure: reason, message } = failure ?? (verdict as VerificationError)
      problems.push({ reason, message: `The stored copy: ${message}` })
      return 'dropped'
    }
    const { statement, keyId } = verdict
    const { version } = statement
    const entry = persisted(artifact)
    // At or below the version in use, the app has this version or a newer one.
    if (version <= inUse(artifact).version || entry.bad.includes(version)) return 'dropped'
    if (isRevoked(artifact, version)) {
      problems.push({
        reason: 'revoked',
        message: `The stored version ${version} of ${artifact.kind} is revoked`,
        version,
      })
      return 'dropped'
    }
    const floor = floorOf(entry)
    if (version < floor) {
      problems.push({
        reason: 'rollback',
        message: `The stored version ${version} is below ${floor}, which this device accepted`,
        version,
      })
      return 'dropped'
    }
    const problem = await activate(artifact, kept.bytes, statement, keyId, 'stored', problems)
    if (problem === undefined) return 'used'
    problems.push(problem)
    return problem.reason === 'unusable' ? 'kept' : 'dropped'
  }

  async function restoreOne(artifact: UpdateArtifact): Promise<ArtifactReport> {
    if (!codeAllowed(artifact)) {
      useBundled(artifact)
      return report(artifact, 'skipped', [optInProblem])
    }
    // Restored or updated earlier in this session: restoring again would change nothing.
    if (runtimeOf(artifact).activated.origin !== 'bundled') return report(artifact, 'current', [])
    if (!(await loadable(artifact))) {
      useBundled(artifact)
      return report(artifact, 'skipped', [codeProblem])
    }
    const problems: UpdateProblem[] = []
    let kept: StoredUpdate | undefined
    try {
      kept = await store.get(artifact.kind)
    } catch (error) {
      problems.push({ reason: 'store-failed', message: messageOf(error) })
    }
    if (kept !== undefined) {
      const result = await restoreStored(artifact, kept, problems)
      if (result === 'used') return report(artifact, 'current', problems)
      if (result === 'dropped') await forget(artifact, problems)
    }
    useBundled(artifact)
    return report(artifact, 'current', problems)
  }

  // --- Check ----------------------------------------------------------------------------------

  async function checkOne(artifact: UpdateArtifact, signal: AbortSignal): Promise<ArtifactReport> {
    if (keys.length === 0) {
      return report(artifact, 'skipped', [
        { reason: 'no-key', message: 'This build trusts no signing key, so it accepts no update' },
      ])
    }
    if (!codeAllowed(artifact)) {
      if (runtimeOf(artifact).activated.origin !== 'bundled') useBundled(artifact)
      return report(artifact, 'skipped', [optInProblem])
    }
    if (!(await loadable(artifact))) return report(artifact, 'skipped', [codeProblem])
    const problems: UpdateProblem[] = []
    let answered = false
    for (const base of baseUrls) {
      signal.throwIfAborted()
      const signatureUrl = `${base}${artifact.file}${SIGNATURE_SUFFIX}`
      let envelope: Uint8Array<ArrayBuffer>
      try {
        envelope = await download(signatureUrl, MAX_SIGNATURE_BYTES, signatureTimeoutMs, signal)
      } catch (error) {
        if (!(error instanceof DownloadProblem)) throw error
        problems.push({ reason: error.reason, message: error.message, url: signatureUrl })
        continue
      }
      const verdict = await verifySignatureFile(envelope, expectationOf(artifact), keys, verifier)
      if (!verdict.ok) {
        problems.push({ reason: verdict.failure, message: verdict.message, url: signatureUrl })
        continue
      }
      const { statement, keyId } = verdict
      const { version } = statement
      const entry = persisted(artifact)
      const floor = floorOf(entry)
      if (isRevoked(artifact, version)) {
        problems.push({
          reason: 'revoked',
          message: `${signatureUrl} offers version ${version}, which this build lists as revoked`,
          url: signatureUrl,
          version,
        })
        continue
      }
      if (version < floor) {
        problems.push({
          reason: 'rollback',
          message: `${signatureUrl} offers version ${version}, below ${floor}, which this device already accepted`,
          url: signatureUrl,
          version,
        })
        continue
      }
      if (version <= inUse(artifact).version) {
        answered = true
        continue
      }
      if (entry.bad.includes(version)) {
        answered = true
        problems.push({
          reason: 'known-bad',
          message: `Version ${version} of ${artifact.kind} failed before`,
          url: signatureUrl,
          version,
        })
        continue
      }
      const artifactUrl = `${base}${artifact.file}`
      let bytes: Uint8Array<ArrayBuffer>
      try {
        bytes = await download(artifactUrl, statement.size, artifactTimeoutMs, signal)
      } catch (error) {
        if (!(error instanceof DownloadProblem)) throw error
        problems.push({ reason: error.reason, message: error.message, url: artifactUrl, version })
        continue
      }
      const mismatch = checkArtifactBytes(bytes, statement)
      if (mismatch !== undefined) {
        problems.push({
          reason: mismatch.failure,
          message: mismatch.message,
          url: artifactUrl,
          version,
        })
        continue
      }
      const problem = await activate(artifact, bytes, statement, keyId, 'fetched', problems)
      if (problem !== undefined) {
        // The same signed bytes would fail from any URL.
        problems.push({ ...problem, url: artifactUrl })
        return report(artifact, 'failed', problems)
      }
      try {
        await store.set(artifact.kind, { envelope, bytes })
      } catch (error) {
        problems.push({ reason: 'store-failed', message: messageOf(error) })
      }
      return report(artifact, 'updated', problems)
    }
    return report(artifact, answered ? 'current' : 'failed', problems)
  }

  async function runCheck(signal: AbortSignal): Promise<UpdateReport> {
    signal.throwIfAborted()
    const reports: ArtifactReport[] = []
    for (const artifact of artifacts) {
      const result = await checkOne(artifact, signal)
      runtime.set(artifact.kind, {
        ...runtimeOf(artifact),
        lastCheck: { at: clock.now(), outcome: result.outcome },
      })
      reports.push(result)
    }
    return { artifacts: reports }
  }

  function restore(): Promise<UpdateReport> {
    return serially(async () => {
      const reports: ArtifactReport[] = []
      for (const artifact of artifacts) reports.push(await restoreOne(artifact))
      return { artifacts: reports }
    })
  }

  /** The check under way, shared by its callers; it stops once all of them have cancelled. */
  let shared:
    | { promise: Promise<UpdateReport>; controller: AbortController; waiting: number }
    | undefined

  function check(checkOptions: UpdateCheckOptions = {}): Promise<UpdateReport> {
    const { signal } = checkOptions
    if (signal?.aborted) return Promise.reject(signal.reason)
    let run = shared
    // A run that every caller left is stopping: a new caller gets a run of its own.
    if (run === undefined || run.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {
        controller,
        waiting: 0,
        promise: serially(() => runCheck(controller.signal)).finally(() => {
          if (shared === created) shared = undefined
        }),
      }
      shared = created
      run = created
    }
    const joined = run
    joined.waiting += 1
    // A caller that can't cancel keeps the check going for everyone.
    if (signal === undefined) return joined.promise
    return new Promise<UpdateReport>((resolve, reject) => {
      const onAbort = () => {
        joined.waiting -= 1
        if (joined.waiting === 0) joined.controller.abort(signal.reason)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      joined.promise.then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  return {
    restore,
    check,
    async start(startOptions = {}) {
      startOptions.signal?.throwIfAborted()
      const restored = await restore()
      const checked = await check(startOptions)
      return {
        artifacts: checked.artifacts.map((entry, index) => ({
          ...entry,
          problems: [...(restored.artifacts[index]?.problems ?? []), ...entry.problems],
        })),
      }
    },
    status() {
      return artifacts.map((artifact) => {
        const { version, origin } = inUse(artifact)
        const { lastCheck } = runtimeOf(artifact)
        const entry = persisted(artifact)
        return {
          kind: artifact.kind,
          version,
          origin,
          floor: floorOf(entry),
          bad: entry.bad,
          ...(lastCheck === undefined ? {} : { lastCheck }),
        }
      })
    },
  }
}
