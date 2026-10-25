/**
 * The few calls to the Firefox Add-ons (AMO) API v5 that `web-ext sign` doesn't make: look up
 * a version, wait until it is signed and download its file. AMO accepts each version number
 * only once, in either channel, so a release run that is re-run after AMO already took its
 * version must fetch that version instead of submitting it again (firefox.ts).
 *
 * Authentication is AMO's JWT scheme (addons-server docs, "Authentication (External)"): an
 * HS256 token with the API key as issuer, signed with the API secret, valid for at most five
 * minutes, sent as `Authorization: JWT <token>`.
 *
 * Facts this relies on (checked 2026-10-26):
 * - Version detail takes a version number instead of an id since 2023-03-02; a number without
 *   dots would be read as an id (addons-server docs, API v5 changelog and "Version Detail").
 * - A file's `status` is `public` once signed, `unreviewed` while waiting and `disabled` when
 *   rejected or disabled; `file.url` downloads it (addons-server docs, "Version Detail").
 * - Version numbers are unique across the listed and unlisted channels, and a deleted version's
 *   number can't be used again (Mozilla Add-ons blog); a duplicate submission gets HTTP 409 since
 *   2023-03-02 (API v5 changelog).
 */
import { createHmac, randomUUID } from 'node:crypto'

export const AMO_API_BASE = 'https://addons.mozilla.org/api/v5/'

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
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface AmoClientOptions {
  credentials: AmoCredentials
  baseUrl?: string
  fetch?: FetchLike
  now?: () => number
}

function parseVersion(data: unknown): AmoVersion {
  if (typeof data !== 'object' || data === null) throw new AmoError('AMO sent no version object')
  const record = data as Record<string, unknown>
  const file = (typeof record.file === 'object' && record.file !== null ? record.file : {}) as {
    status?: unknown
    url?: unknown
  }
  if (typeof record.id !== 'number' || typeof record.version !== 'string') {
    throw new AmoError('AMO sent a version without an id or a version number')
  }
  return {
    id: record.id,
    version: record.version,
    channel: typeof record.channel === 'string' ? record.channel : 'unknown',
    status: typeof file.status === 'string' ? file.status : 'unknown',
    fileUrl: typeof file.url === 'string' ? file.url : null,
    editUrl: typeof record.edit_url === 'string' ? record.edit_url : null,
  }
}

async function describeFailure(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 500)
  return `HTTP ${response.status}${text ? `: ${text}` : ''}`
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

  #request(url: string): Promise<Response> {
    return this.#fetch(url, {
      headers: {
        Authorization: amoAuthorization(this.#credentials, this.#now()),
        Accept: 'application/json',
      },
    })
  }

  /**
   * A version of an add-on by version number, or null when AMO has no such version (or no such
   * add-on yet). The add-on's authors see unlisted versions too.
   */
  async getVersion(guid: string, version: string): Promise<AmoVersion | null> {
    // A version number with dots is looked up as a number, not as an id (AMO API v5).
    if (!version.includes('.')) throw new AmoError(`not a dotted version number: ${version}`)
    const url = new URL(
      `addons/addon/${encodeURIComponent(guid)}/versions/${encodeURIComponent(version)}/`,
      this.#baseUrl,
    )
    const response = await this.#request(url.href)
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) {
      throw new AmoError(
        `AMO refused to show ${guid} ${version} (${await describeFailure(response)}). Check that ` +
          'AMO_API_KEY and AMO_API_SECRET are current credentials of an account that owns the add-on.',
        response.status,
      )
    }
    if (!response.ok) {
      throw new AmoError(
        `looking up ${guid} ${version} failed: ${await describeFailure(response)}`,
        response.status,
      )
    }
    return parseVersion(await response.json())
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
    const response = await this.#request(url.href)
    if (!response.ok) {
      throw new AmoError(`downloading ${fileUrl} failed: HTTP ${response.status}`, response.status)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}

export interface WaitOptions {
  /** Give up after this long and return the version as it is. */
  timeoutMs: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called after every look that finds the version still waiting for review. */
  onWait?: (version: AmoVersion) => void
}

/**
 * Looks up a version until its file is signed (`public`) or rejected (`disabled`), or until the
 * timeout. Returns the last answer: the caller decides what a version still in review means.
 * Null when AMO has no such version.
 */
export async function waitForReview(
  client: Pick<AmoClient, 'getVersion'>,
  guid: string,
  version: string,
  {
    timeoutMs,
    intervalMs = 15_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    onWait,
  }: WaitOptions,
): Promise<AmoVersion | null> {
  const deadline = now() + timeoutMs
  for (;;) {
    const found = await client.getVersion(guid, version)
    if (!found || found.status === 'public' || found.status === 'disabled') return found
    if (now() + intervalMs > deadline) return found
    onWait?.(found)
    await sleep(intervalMs)
  }
}
