/**
 * The Firefox Add-ons (AMO) API v5 calls of the release workflow's Firefox jobs (firefox.ts):
 * upload FXM Connect, create the version with its metadata, attach the source code, look the
 * version up, wait for Mozilla's signature and download the signed file.
 *
 * These are the calls `web-ext sign` makes (web-ext 10.7.0, lib/util/submit-addon.js, read
 * 2026-10-26), made here with Node's own fetch and crypto. The jobs that hold the AMO keys
 * therefore install and run no third-party code at all: no web-ext, no npm packages.
 *
 * Authentication is AMO's JWT scheme (addons-server docs, "Authentication (External)"): an
 * HS256 token with the API key as issuer, signed with the API secret, valid for at most five
 * minutes, sent as `Authorization: JWT <token>`.
 *
 * Facts this relies on (addons-server docs, "Add-ons" API v5, read 2026-10-26):
 * - POST addons/upload/ takes the file as multipart form data, with `upload` and `channel`
 *   (`listed` or `unlisted`). GET addons/upload/<uuid>/ reports `processed`, `valid` and the
 *   validation results. An upload can be submitted only once.
 * - PUT addons/addon/<guid>/ with `version: { upload, … }` creates the add-on the first time and
 *   a new version afterwards; its answer is the add-on, with the new version in `version`.
 * - PATCH addons/addon/<guid>/versions/<id>/ takes the source code, as multipart only.
 * - Version detail takes a version number instead of an id since 2023-03-02; a number without
 *   dots would be read as an id (API v5 changelog and "Version Detail").
 * - A file's `status` is `public` once signed, `unreviewed` while waiting and `disabled` when
 *   rejected or disabled; `file.url` downloads it. `source` is the uploaded source code's URL,
 *   or null, and only the add-on's authors see it.
 * - Version numbers are unique across the listed and unlisted channels, and a deleted version's
 *   number can't be used again (Mozilla Add-ons blog); a duplicate gets HTTP 409.
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { AmoChannel, AmoMetadata } from './listing.ts'

export const AMO_API_BASE = 'https://addons.mozilla.org/api/v5/'

/** How long one API request may take, and an upload of a file. */
const REQUEST_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 5 * 60_000

export interface AmoCredentials {
  /** The "JWT issuer" of the AMO API credentials. */
  key: string
  /** The "JWT secret" of the AMO API credentials. */
  secret: string
}

/** A failed AMO API call, with AMO's answer when there is one. */
export class AmoError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AmoError'
    this.status = status
  }
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** The Authorization header value for one request. */
export function amoAuthorization(
  { key, secret }: AmoCredentials,
  nowMs: number = Date.now(),
  nonce: string = randomUUID(),
): string {
  const iat = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iss: key, jti: nonce, iat, exp: iat + 300 }))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `JWT ${header}.${payload}.${signature}`
}

/** The parts of AMO's version object that the release needs. */
export interface AmoVersion {
  id: number
  version: string
  /** `listed`, `unlisted` (or `enterprise`). */
  channel: string
  /** The file's review status: `public` (signed), `unreviewed` or `disabled`. */
  status: string
  /** Where to download the signed file, once `status` is `public`. */
  fileUrl: string | null
  /** The version's page in AMO's Developer Hub, when AMO says. */
  editUrl: string | null
  /** Whether the version has its source code; null when AMO didn't say. */
  hasSource: boolean | null
}

/** An upload as AMO's validator reports it. */
export interface AmoUpload {
  uuid: string
  /** The validator has finished. */
  processed: boolean
  /** It found no errors. */
  valid: boolean
  /** The validator's errors, one line each. */
  errors: string[]
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface AmoClientOptions {
  credentials: AmoCredentials
  baseUrl?: string
  fetch?: FetchLike
  now?: () => number
}

function record(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

function parseVersion(data: unknown): AmoVersion {
  if (typeof data !== 'object' || data === null) throw new AmoError('AMO sent no version object')
  const version = record(data)
  const file = record(version.file)
  if (typeof version.id !== 'number' || typeof version.version !== 'string') {
    throw new AmoError('AMO sent a version without an id or a version number')
  }
  return {
    id: version.id,
    version: version.version,
    channel: typeof version.channel === 'string' ? version.channel : 'unknown',
    status: typeof file.status === 'string' ? file.status : 'unknown',
    fileUrl: typeof file.url === 'string' ? file.url : null,
    editUrl: typeof version.edit_url === 'string' ? version.edit_url : null,
    hasSource: 'source' in version ? typeof version.source === 'string' : null,
  }
}

/** The validator's errors as lines, from AMO's validation results. */
function validationErrors(validation: unknown): string[] {
  const messages = record(validation).messages
  if (!Array.isArray(messages)) return []
  return messages
    .map(record)
    .filter((message) => message.type === 'error')
    .map((message) => {
      const text = typeof message.message === 'string' ? message.message : 'unknown error'
      return typeof message.file === 'string' && message.file ? `${text} (${message.file})` : text
    })
}

function parseUpload(data: unknown): AmoUpload {
  const upload = record(data)
  if (typeof upload.uuid !== 'string' || !/^[\w-]+$/.test(upload.uuid)) {
    throw new AmoError('AMO sent an upload without a valid uuid')
  }
  return {
    uuid: upload.uuid,
    processed: upload.processed === true,
    valid: upload.valid === true,
    errors: validationErrors(upload.validation),
  }
}

async function describeFailure(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 500)
  return `HTTP ${response.status}${text ? `: ${text}` : ''}`
}

const CREDENTIALS_HINT =
  'Check that AMO_API_KEY and AMO_API_SECRET are current credentials of the account that owns ' +
  'the add-on (apps/extension/README.md, "Store channels").'

/** A file for multipart form data, under the name AMO checks the extension of. */
function formFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/zip' })
}

export class AmoClient {
  readonly #credentials: AmoCredentials
  readonly #baseUrl: string
  readonly #fetch: FetchLike
  readonly #now: () => number

  constructor({
    credentials,
    baseUrl = AMO_API_BASE,
    fetch = globalThis.fetch,
    now = Date.now,
  }: AmoClientOptions) {
    this.#credentials = credentials
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    this.#fetch = fetch
    this.#now = now
  }

  #url(path: string): string {
    return new URL(path, this.#baseUrl).href
  }

  #addonPath(guid: string): string {
    return `addons/addon/${encodeURIComponent(guid)}/`
  }

  /** One authenticated request, with a fresh token. */
  #request(
    url: string,
    { method = 'GET', body, json }: { method?: string; body?: BodyInit; json?: boolean } = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    return this.#fetch(url, {
      method,
      headers: {
        Authorization: amoAuthorization(this.#credentials, this.#now()),
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** The JSON answer of a successful request; a clear AmoError otherwise. */
  async #answer(what: string, response: Response): Promise<unknown> {
    if (!response.ok) {
      const failure = await describeFailure(response)
      const hint =
        response.status === 401 || response.status === 403
          ? ` ${CREDENTIALS_HINT}`
          : response.status === 409
            ? ' AMO accepts each version number once, in either channel.'
            : ''
      throw new AmoError(`${what} failed (${failure}).${hint}`, response.status)
    }
    try {
      return await response.json()
    } catch {
      throw new AmoError(`${what}: AMO's answer is not JSON`, response.status)
    }
  }

  /**
   * A version of an add-on by version number, or null when AMO has no such version (or no such
   * add-on yet). The add-on's authors see unlisted versions too.
   */
  async getVersion(guid: string, version: string): Promise<AmoVersion | null> {
    // A version number with dots is looked up as a number, not as an id (AMO API v5).
    if (!version.includes('.')) throw new AmoError(`not a dotted version number: ${version}`)
    const url = this.#url(`${this.#addonPath(guid)}versions/${encodeURIComponent(version)}/`)
    const response = await this.#request(url)
    if (response.status === 404) return null
    return parseVersion(await this.#answer(`Looking up ${guid} ${version}`, response))
  }

  /** Uploads an add-on file for AMO's validator; returns the upload's uuid. */
  async upload(file: Uint8Array, name: string, channel: AmoChannel): Promise<string> {
    const form = new FormData()
    form.set('channel', channel)
    form.set('upload', formFile(file, name))
    const response = await this.#request(
      this.#url('addons/upload/'),
      { method: 'POST', body: form },
      UPLOAD_TIMEOUT_MS,
    )
    return parseUpload(await this.#answer(`Uploading ${name}`, response)).uuid
  }

  /** What AMO's validator says about an upload so far. */
  async uploadStatus(uuid: string): Promise<AmoUpload> {
    const response = await this.#request(this.#url(`addons/upload/${encodeURIComponent(uuid)}/`))
    return parseUpload(await this.#answer(`Checking upload ${uuid}`, response))
  }

  /**
   * Turns a validated upload into a new version of the add-on, with the version's metadata
   * (and, for a listed version, the listing), creating the add-on the first time.
   */
  async submitVersion(guid: string, upload: string, metadata: AmoMetadata): Promise<AmoVersion> {
    const body = JSON.stringify({ ...metadata, version: { upload, ...metadata.version } })
    const response = await this.#request(this.#url(this.#addonPath(guid)), {
      method: 'PUT',
      body,
      json: true,
    })
    const addon = record(await this.#answer(`Submitting the version of ${guid}`, response))
    return parseVersion(addon.version)
  }

  /** Attaches the source code to a version, for AMO's reviewers. */
  async uploadSource(guid: string, versionId: number, file: Uint8Array, name: string) {
    const form = new FormData()
    form.set('source', formFile(file, name))
    const response = await this.#request(
      this.#url(`${this.#addonPath(guid)}versions/${versionId}/`),
      { method: 'PATCH', body: form },
      UPLOAD_TIMEOUT_MS,
    )
    await this.#answer(`Uploading the source code of version ${versionId}`, response)
  }

  /**
   * Downloads a signed file. AMO's file URLs are on its own host and need the same token, which
   * never goes to any other host.
   */
  async download(fileUrl: string): Promise<Uint8Array> {
    const base = new URL(this.#baseUrl)
    const url = new URL(fileUrl)
    if (url.origin !== base.origin) {
      throw new AmoError(`AMO's file URL ${fileUrl} is not on ${base.origin}: not downloading it`)
    }
    const response = await this.#request(url.href, {}, UPLOAD_TIMEOUT_MS)
    if (!response.ok) {
      throw new AmoError(`downloading ${fileUrl} failed: HTTP ${response.status}`, response.status)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}

/** A failure worth asking again about: AMO overloaded or down, or the network. */
export function isTransient(error: unknown): boolean {
  if (error instanceof AmoError) {
    return error.status !== undefined && (error.status >= 500 || error.status === 429)
  }
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
}

export interface WaitOptions {
  /** Give up after this long and return the last answer. */
  timeoutMs: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How many failed looks in a row to bear before giving up (isTransient failures only). */
  maxFailures?: number
}

/**
 * Asks `check` until `done` holds for its answer or the time is up, and returns the last answer.
 * A transient failure is asked again, up to `maxFailures` in a row.
 */
async function poll<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
  onWait: ((value: T) => void) | undefined,
  {
    timeoutMs,
    intervalMs = 15_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    maxFailures = 3,
  }: WaitOptions,
): Promise<T> {
  const deadline = now() + timeoutMs
  let failures = 0
  for (;;) {
    let answer: { value: T } | null = null
    try {
      answer = { value: await check() }
      failures = 0
    } catch (error) {
      failures++
      if (!isTransient(error) || failures > maxFailures || now() + intervalMs > deadline) {
        throw error
      }
    }
    if (answer && done(answer.value)) return answer.value
    if (answer && now() + intervalMs > deadline) return answer.value
    if (answer) onWait?.(answer.value)
    await sleep(intervalMs)
  }
}

/**
 * Looks up a version until its file is signed (`public`) or rejected (`disabled`), or until the
 * timeout. Returns the last answer: the caller decides what a version still in review means.
 * Null when AMO has no such version.
 */
export function waitForReview(
  client: Pick<AmoClient, 'getVersion'>,
  guid: string,
  version: string,
  options: WaitOptions & { onWait?: (version: AmoVersion) => void },
): Promise<AmoVersion | null> {
  return poll(
    () => client.getVersion(guid, version),
    (found) => !found || found.status === 'public' || found.status === 'disabled',
    (found) => {
      if (found) options.onWait?.(found)
    },
    options,
  )
}

/** Asks AMO about an upload until its validator has finished, or until the timeout. */
export function waitForValidation(
  client: Pick<AmoClient, 'uploadStatus'>,
  uuid: string,
  options: WaitOptions,
): Promise<AmoUpload> {
  return poll(
    () => client.uploadStatus(uuid),
    (upload) => upload.processed,
    undefined,
    options,
  )
}
