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
 *   never when it is lower than the highest version this device ever accepted (the floor,
 *   kept even when the stored copy is lost).
 * - **Bad versions.** A validly signed version that fails to load is remembered and never
 *   downloaded again; the next higher version is.
 * - **F-Droid builds** download and load code only after the user's opt-in.
 *
 * The web app doesn't use the updater: it gets new code and config by redeploy.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { type Clock, systemClock } from '../clock.ts'
import type { NativeHttp } from '../native.ts'
import { type KeyValueStorage, memoryStorage, readJson, writeJson } from '../storage.ts'
import type { UpdateArtifact, UpdateOrigin } from './artifact.ts'
import { concatBytes } from './encoding.ts'
import { MAX_SIGNATURE_BYTES, SIGNATURE_SUFFIX, type UpdateStatement } from './format.ts'
import { type TrustedKey, UPDATE_SIGNING_KEYS } from './keys.ts'
import { type Distribution, updatePolicy } from './policy.ts'
import { memoryUpdateStore, type StoredUpdate, type UpdateStore } from './store.ts'
import {
  type ArtifactExpectation,
  checkArtifactBytes,
  createSignatureVerifier,
  type SignatureVerifier,
  type VerificationError,
  type VerificationFailure,
  verifySignatureFile,
} from './verify.ts'

/**
 * Where FXM publishes signed updates: the `/updates/` folder of the static site. A stage that
 * renames the site changes it here.
 */
export const DEFAULT_UPDATE_BASE_URLS: readonly string[] = ['https://fxm-music.pages.dev/updates/']

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
  /** A version that failed to load before, which is not tried again. */
  | 'known-bad'
  /** A verified version that failed to load or that the artifact refused. */
  | 'load-failed'
  /** The last good version could not be read or saved. */
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
 * - `skipped`: not checked: the build trusts no key, or code updates wait for the opt-in;
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
  /** The highest version this device ever accepted; versions below it are refused. */
  readonly floor: number
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
  /** Where the last good versions are kept. Default: memory (nothing survives a restart). */
  readonly store?: UpdateStore
  /** Where the floors and bad versions are kept, e.g. `localStorage`. Default: memory. */
  readonly state?: KeyValueStorage
  /** The trusted public keys. Default: the ones compiled into the build. */
  readonly keys?: readonly TrustedKey[]
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
  /** Cancels the check; the version in use stays. */
  readonly signal?: AbortSignal
}

/** Keeps the signed artifacts of a desktop or Android app current. */
export interface Updater {
  /**
   * Switches each artifact to its last good stored version, verified again, or else to the copy
   * the app ships with. Makes no request. Call it once at start.
   */
  restore(): Promise<UpdateReport>
  /**
   * Looks for newer signed versions at each URL in turn and switches to them. Never throws for
   * network or verification problems: they are in the report. Concurrent calls share one check.
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
  floor: number
  bad: number[]
}

/** What the updater knows about an artifact while it runs. */
interface Runtime {
  version: number
  origin: UpdateOrigin
  lastCheck?: { at: number; outcome: ArtifactOutcome }
}

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

function isPersistedKind(value: unknown): value is PersistedKind {
  const { floor, bad } = (value ?? {}) as Partial<PersistedKind>
  return (
    Number.isSafeInteger(floor) &&
    (floor as number) >= 0 &&
    Array.isArray(bad) &&
    bad.every((version) => Number.isSafeInteger(version))
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 * @throws FxmError `Unsupported` for an update URL that is not a plain HTTPS folder.
 */
export function createUpdater(options: UpdaterOptions): Updater {
  const artifacts = options.artifacts
  const baseUrls = (options.baseUrls ?? DEFAULT_UPDATE_BASE_URLS).map(normalizeUpdateBaseUrl)
  const store = options.store ?? memoryUpdateStore()
  const state = options.state ?? memoryStorage()
  const keys = options.keys ?? UPDATE_SIGNING_KEYS.keys
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
      { version: artifact.bundledVersion, origin: 'bundled' as const },
    ]),
  )
  let checking: Promise<UpdateReport> | undefined

  // --- Persisted floors and bad versions ---------------------------------------------------

  function persisted(kind: string): PersistedKind {
    const all = readJson(state, UPDATE_STATE_KEY)
    const entry = (all as Record<string, unknown> | undefined)?.[kind]
    return isPersistedKind(entry)
      ? { floor: entry.floor, bad: [...entry.bad] }
      : { floor: 0, bad: [] }
  }

  function persist(kind: string, entry: PersistedKind): void {
    const all = readJson(state, UPDATE_STATE_KEY)
    const next =
      typeof all === 'object' && all !== null && !Array.isArray(all)
        ? { ...(all as Record<string, unknown>) }
        : {}
    next[kind] = entry
    writeJson(state, UPDATE_STATE_KEY, next)
  }

  function raiseFloor(kind: string, version: number): void {
    const entry = persisted(kind)
    if (version > entry.floor) persist(kind, { ...entry, floor: version })
  }

  function markBad(kind: string, version: number): void {
    const entry = persisted(kind)
    if (entry.bad.includes(version)) return
    persist(kind, { ...entry, bad: [...entry.bad, version].slice(-MAX_BAD_VERSIONS) })
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

  function current(artifact: UpdateArtifact): Runtime {
    return runtime.get(artifact.kind) as Runtime
  }

  function report(
    artifact: UpdateArtifact,
    outcome: ArtifactOutcome,
    problems: readonly UpdateProblem[],
  ): ArtifactReport {
    const { version, origin } = current(artifact)
    return { kind: artifact.kind, outcome, version, origin, problems }
  }

  function useBundled(artifact: UpdateArtifact): void {
    artifact.useBundled()
    runtime.set(artifact.kind, {
      ...current(artifact),
      version: artifact.bundledVersion,
      origin: 'bundled',
    })
  }

  async function forget(artifact: UpdateArtifact, problems: UpdateProblem[]): Promise<void> {
    try {
      await store.delete(artifact.kind)
    } catch (error) {
      problems.push({ reason: 'store-failed', message: messageOf(error) })
    }
  }

  /** Loads and activates a verified artifact; returns a problem when it can't be used. */
  async function activate(
    artifact: UpdateArtifact,
    bytes: Uint8Array<ArrayBuffer>,
    statement: UpdateStatement,
    origin: 'stored' | 'fetched',
  ): Promise<UpdateProblem | undefined> {
    try {
      const value = await artifact.load(bytes, statement)
      artifact.activate(value, { origin, version: statement.version })
    } catch (error) {
      markBad(artifact.kind, statement.version)
      return {
        reason: 'load-failed',
        message: `Version ${statement.version} of ${artifact.kind} can't be used: ${messageOf(error)}`,
        version: statement.version,
      }
    }
    runtime.set(artifact.kind, { ...current(artifact), version: statement.version, origin })
    raiseFloor(artifact.kind, statement.version)
    return undefined
  }

  /** Downloads a file of at most `maxBytes`, within `timeoutMs`. */
  async function download(
    url: string,
    maxBytes: number,
    timeoutMs: number,
    outer: AbortSignal | undefined,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = clock.setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The update request timed out', 'TimeoutError'))
    }, timeoutMs)
    const onAbort = () => controller.abort(outer?.reason)
    outer?.addEventListener('abort', onAbort, { once: true })
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
      if (outer?.aborted) throw outer.reason
      if (error instanceof DownloadProblem) throw error
      if (timedOut) throw new DownloadProblem('timeout', `${url} took longer than ${timeoutMs} ms`)
      throw new DownloadProblem('unreachable', `${url} could not be fetched: ${messageOf(error)}`)
    } finally {
      clock.clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
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

  const optInProblem: UpdateProblem = {
    reason: 'needs-opt-in',
    message: 'Downloaded code is off until the user turns it on',
  }

  // --- Restore --------------------------------------------------------------------------------

  /** Switches to the stored copy of an artifact, if it is still good; says whether it did. */
  async function restoreStored(
    artifact: UpdateArtifact,
    stored: StoredUpdate,
    problems: UpdateProblem[],
  ): Promise<boolean> {
    const verdict = await verifySignatureFile(
      stored.signature,
      expectationOf(artifact),
      keys,
      verifier,
    )
    const failure = verdict.ok ? checkArtifactBytes(stored.bytes, verdict.statement) : verdict
    if (!verdict.ok || failure !== undefined) {
      const { failure: reason, message } = failure ?? (verdict as VerificationError)
      problems.push({ reason, message: `The stored copy: ${message}` })
      return false
    }
    const { version } = verdict.statement
    const { floor, bad } = persisted(artifact.kind)
    // At or below the bundled version, the app ships this version or a newer one.
    if (version <= artifact.bundledVersion || bad.includes(version)) return false
    if (version < floor) {
      problems.push({
        reason: 'rollback',
        message: `The stored version ${version} is below ${floor}, which this device accepted`,
        version,
      })
      return false
    }
    const problem = await activate(artifact, stored.bytes, verdict.statement, 'stored')
    if (problem !== undefined) problems.push(problem)
    return problem === undefined
  }

  async function restoreOne(artifact: UpdateArtifact): Promise<ArtifactReport> {
    if (!codeAllowed(artifact)) {
      useBundled(artifact)
      return report(artifact, 'skipped', [optInProblem])
    }
    const problems: UpdateProblem[] = []
    let stored: StoredUpdate | undefined
    try {
      stored = await store.get(artifact.kind)
    } catch (error) {
      problems.push({ reason: 'store-failed', message: messageOf(error) })
    }
    if (stored !== undefined) {
      if (await restoreStored(artifact, stored, problems)) {
        return report(artifact, 'current', problems)
      }
      await forget(artifact, problems)
    }
    useBundled(artifact)
    return report(artifact, 'current', problems)
  }

  // --- Check ----------------------------------------------------------------------------------

  async function checkOne(
    artifact: UpdateArtifact,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactReport> {
    if (keys.length === 0) {
      return report(artifact, 'skipped', [
        { reason: 'no-key', message: 'This build trusts no signing key, so it accepts no update' },
      ])
    }
    if (!codeAllowed(artifact)) {
      if (current(artifact).origin !== 'bundled') useBundled(artifact)
      return report(artifact, 'skipped', [optInProblem])
    }
    const problems: UpdateProblem[] = []
    let answered = false
    for (const base of baseUrls) {
      signal?.throwIfAborted()
      const signatureUrl = `${base}${artifact.file}${SIGNATURE_SUFFIX}`
      let signature: Uint8Array<ArrayBuffer>
      try {
        signature = await download(signatureUrl, MAX_SIGNATURE_BYTES, signatureTimeoutMs, signal)
      } catch (error) {
        if (!(error instanceof DownloadProblem)) throw error
        problems.push({ reason: error.reason, message: error.message, url: signatureUrl })
        continue
      }
      const verdict = await verifySignatureFile(signature, expectationOf(artifact), keys, verifier)
      if (!verdict.ok) {
        problems.push({ reason: verdict.failure, message: verdict.message, url: signatureUrl })
        continue
      }
      const { statement } = verdict
      const { floor, bad } = persisted(artifact.kind)
      const { version } = statement
      if (version < floor) {
        problems.push({
          reason: 'rollback',
          message: `${signatureUrl} offers version ${version}, below ${floor}, which this device already accepted`,
          url: signatureUrl,
          version,
        })
        continue
      }
      if (version <= current(artifact).version) {
        answered = true
        continue
      }
      if (bad.includes(version)) {
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
      const problem = await activate(artifact, bytes, statement, 'fetched')
      if (problem !== undefined) {
        // The same signed bytes would fail from any URL.
        problems.push({ ...problem, url: artifactUrl })
        return report(artifact, 'failed', problems)
      }
      try {
        await store.set(artifact.kind, { signature, bytes })
      } catch (error) {
        problems.push({ reason: 'store-failed', message: messageOf(error) })
      }
      return report(artifact, 'updated', problems)
    }
    return report(artifact, answered ? 'current' : 'failed', problems)
  }

  async function runCheck(signal: AbortSignal | undefined): Promise<UpdateReport> {
    const reports: ArtifactReport[] = []
    for (const artifact of artifacts) {
      const result = await checkOne(artifact, signal)
      const entry = current(artifact)
      runtime.set(artifact.kind, {
        ...entry,
        lastCheck: { at: clock.now(), outcome: result.outcome },
      })
      reports.push(result)
    }
    return { artifacts: reports }
  }

  async function restore(): Promise<UpdateReport> {
    const reports: ArtifactReport[] = []
    for (const artifact of artifacts) reports.push(await restoreOne(artifact))
    return { artifacts: reports }
  }

  function check(checkOptions: UpdateCheckOptions = {}): Promise<UpdateReport> {
    checking ??= runCheck(checkOptions.signal).finally(() => {
      checking = undefined
    })
    return checking
  }

  return {
    restore,
    check,
    async start(startOptions = {}) {
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
        const { version, origin, lastCheck } = current(artifact)
        return {
          kind: artifact.kind,
          version,
          origin,
          floor: persisted(artifact.kind).floor,
          ...(lastCheck === undefined ? {} : { lastCheck }),
        }
      })
    },
  }
}
