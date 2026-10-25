/**
 * Submits FXM Connect to Edge Add-ons with the Edge Add-ons API v1.1, in the release workflow
 * (.github/workflows/release.yml, job "edge"), after the GitHub Release is published:
 *
 *   edge.ts plan                             whether the three Edge secrets are set
 *   edge.ts submit --zip <file> --version x.y.z
 *                                            uploads the release's Chromium zip as the draft's
 *                                            package and submits the draft for certification
 *
 * The API only updates an extension that already exists: the owner creates it once in Partner
 * Center (apps/extension/README.md, "Store channels"). Certification takes up to seven business
 * days, so the job submits and doesn't wait for the outcome.
 *
 * Endpoints (learn.microsoft.com, "Use the REST API to update an extension", updated 2026-09-02):
 * POST /v1/products/{product}/submissions/draft/package and POST /v1/products/{product}/
 * submissions answer 202 with the operation ID in Location; GET .../operations/{id} gives its
 * status: InProgress, Succeeded or Failed (with errorCode, message and errors).
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSION_NAME } from '../src/config.ts'
import { createReporter, parseOptions, type Reporter, requireOption, sleep } from './actions.ts'
import { reviewerNotes } from './listing.ts'
import { readZip } from './xpi.ts'

export const EDGE_API_BASE = 'https://api.addons.microsoftedge.microsoft.com'

export interface EdgeCredentials {
  productId: string
  clientId: string
  apiKey: string
}

/** Status of an upload or publish operation. */
export interface EdgeOperation {
  status: string
  message: string | null
  errorCode: string | null
  errors: string[]
}

export class EdgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdgeError'
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function describeErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return []
  return errors.map((error) =>
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error),
  )
}

/** The operation ID from a Location header: the ID itself, or a URL or path ending with it. */
export function operationId(location: string | null): string {
  const id = location?.trim().replace(/\/+$/, '').split('/').pop() ?? ''
  if (!/^[\w-]+$/.test(id)) throw new EdgeError(`Edge Add-ons sent no operation ID (${location})`)
  return id
}

export class EdgeClient {
  readonly #credentials: EdgeCredentials
  readonly #baseUrl: string
  readonly #fetch: FetchLike

  constructor(
    credentials: EdgeCredentials,
    {
      baseUrl = EDGE_API_BASE,
      fetch = globalThis.fetch,
    }: { baseUrl?: string; fetch?: FetchLike } = {},
  ) {
    this.#credentials = credentials
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#fetch = fetch
  }

  #url(path: string): string {
    return `${this.#baseUrl}/v1/products/${encodeURIComponent(this.#credentials.productId)}${path}`
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `ApiKey ${this.#credentials.apiKey}`,
      'X-ClientID': this.#credentials.clientId,
      ...extra,
    }
  }

  async #start(what: string, path: string, init: RequestInit): Promise<string> {
    const response = await this.#fetch(this.#url(path), init)
    if (response.status !== 202) {
      const text = (await response.text().catch(() => '')).slice(0, 500)
      const hint =
        response.status === 401
          ? ': check EDGE_CLIENT_ID and EDGE_API_KEY (API keys expire; Partner Center shows when)'
          : response.status === 404
            ? ': check EDGE_PRODUCT_ID (Partner Center, Extension overview)'
            : ''
      throw new EdgeError(
        `${what} failed: HTTP ${response.status}${hint}${text ? `: ${text}` : ''}`,
      )
    }
    return operationId(response.headers.get('location'))
  }

  async #status(what: string, path: string): Promise<EdgeOperation> {
    const response = await this.#fetch(this.#url(path), { headers: this.#headers() })
    if (!response.ok) throw new EdgeError(`checking the ${what} failed: HTTP ${response.status}`)
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return {
      status: typeof data.status === 'string' ? data.status : 'Unknown',
      message: typeof data.message === 'string' ? data.message : null,
      errorCode: typeof data.errorCode === 'string' && data.errorCode ? data.errorCode : null,
      errors: describeErrors(data.errors),
    }
  }

  /** Uploads a package as the draft submission's package; returns the operation ID. */
  uploadPackage(zip: Uint8Array<ArrayBuffer>): Promise<string> {
    return this.#start('Uploading the package', '/submissions/draft/package', {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/zip' }),
      body: zip,
    })
  }

  uploadStatus(operation: string): Promise<EdgeOperation> {
    return this.#status('upload', `/submissions/draft/package/operations/${operation}`)
  }

  /** Submits the draft for certification, with notes for the testers. */
  publish(notes: string): Promise<string> {
    return this.#start('Submitting the draft', '/submissions', {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ notes }),
    })
  }

  publishStatus(operation: string): Promise<EdgeOperation> {
    return this.#status('submission', `/submissions/operations/${operation}`)
  }
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Polls an operation until it leaves InProgress or the timeout passes. */
export async function settle(
  check: () => Promise<EdgeOperation>,
  { intervalMs = 5000, timeoutMs = 300_000, sleep: wait = sleep, now = Date.now }: PollOptions = {},
): Promise<EdgeOperation> {
  const deadline = now() + timeoutMs
  for (;;) {
    const operation = await check()
    if (operation.status !== 'InProgress' || now() + intervalMs > deadline) return operation
    await wait(intervalMs)
  }
}

function explain(operation: EdgeOperation): string {
  return [operation.errorCode, operation.message, ...operation.errors].filter(Boolean).join(': ')
}

export type SubmitOutcome =
  /** Submitted for certification. */
  | 'submitted'
  /** An earlier submission is still in review, so the package waits in the draft. */
  | 'in-review'
  /** The store already has this package: nothing new to submit. */
  | 'unchanged'
  /** The store took the request but hadn't finished it when the job stopped waiting. */
  | 'pending'

export async function submitToEdge(
  client: Pick<EdgeClient, 'uploadPackage' | 'uploadStatus' | 'publish' | 'publishStatus'>,
  zip: Uint8Array<ArrayBuffer>,
  notes: string,
  poll: PollOptions = {},
): Promise<{ outcome: SubmitOutcome; detail: string }> {
  const uploadId = await client.uploadPackage(zip)
  const upload = await settle(() => client.uploadStatus(uploadId), poll)
  if (upload.status === 'InProgress') {
    return { outcome: 'pending', detail: `the upload is still being processed (${uploadId})` }
  }
  if (upload.status !== 'Succeeded') {
    throw new EdgeError(`Edge Add-ons refused the package: ${explain(upload)}`)
  }
  const publishId = await client.publish(notes)
  const submission = await settle(() => client.publishStatus(publishId), poll)
  if (submission.status === 'Succeeded') {
    return { outcome: 'submitted', detail: submission.message ?? '' }
  }
  if (submission.status === 'InProgress') {
    return { outcome: 'pending', detail: `the submission is still being processed (${publishId})` }
  }
  if (submission.errorCode === 'InProgressSubmission') {
    return { outcome: 'in-review', detail: explain(submission) }
  }
  if (submission.errorCode === 'NoModulesUpdated') {
    return { outcome: 'unchanged', detail: explain(submission) }
  }
  const hint =
    submission.errorCode === 'CreateNotAllowed'
      ? ' (the API only updates an extension that was first published in Partner Center)'
      : ''
  throw new EdgeError(`Edge Add-ons refused the submission${hint}: ${explain(submission)}`)
}

/** Checks that a zip is the release build of FXM Connect at the given version. */
export function checkReleaseZip(zip: Uint8Array, version: string): void {
  const manifestEntry = readZip(zip).find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new EdgeError('the zip has no manifest.json at its top')
  const manifest = JSON.parse(Buffer.from(manifestEntry.data).toString('utf8')) as {
    name?: unknown
    version?: unknown
    host_permissions?: unknown
  }
  if (manifest.version !== version) {
    throw new EdgeError(`the zip holds version ${String(manifest.version)}, not ${version}`)
  }
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []
  if (
    manifest.name !== EXTENSION_NAME ||
    hosts.some((host) => String(host).includes('localhost'))
  ) {
    throw new EdgeError('the zip is not the release build: never submit the development build')
  }
}

const SECRETS = ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'] as const

/** The Edge credentials, or null after telling the owner which secrets are missing. */
export function planSubmission(env: NodeJS.ProcessEnv, reporter: Reporter): EdgeCredentials | null {
  const missing = SECRETS.filter((name) => !env[name]?.trim())
  if (missing.length === SECRETS.length) {
    reporter.notice(
      'Edge Add-ons',
      `${SECRETS.join(', ')} are not set, so this release isn't submitted to Edge Add-ons. ` +
        'apps/extension/README.md ("Store channels") says how to set them up.',
    )
    return null
  }
  if (missing.length > 0) {
    reporter.warning(
      'Edge Add-ons',
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, so this release ` +
        `isn't submitted to Edge Add-ons. Set all of ${SECRETS.join(', ')}.`,
    )
    return null
  }
  return {
    productId: env.EDGE_PRODUCT_ID?.trim() ?? '',
    clientId: env.EDGE_CLIENT_ID?.trim() ?? '',
    apiKey: env.EDGE_API_KEY?.trim() ?? '',
  }
}

const MESSAGES: Record<SubmitOutcome, (version: string) => string> = {
  submitted: (version) =>
    `Submitted FXM Connect ${version} to Edge Add-ons. Certification takes up to seven business ` +
    'days; Partner Center shows the outcome.',
  'in-review': (version) =>
    `Edge Add-ons is still reviewing an earlier submission, so ${version} waits in the draft. ` +
    'Publish it in Partner Center once that review is done, or let the next release submit it.',
  unchanged: (version) => `Edge Add-ons already has the package of ${version}: nothing to submit.`,
  pending: (version) =>
    `Edge Add-ons took the request for ${version} but hadn't finished it after five minutes. ` +
    'Check Partner Center.',
}

async function main(args: readonly string[], reporter: Reporter): Promise<void> {
  const [command, ...rest] = args
  const credentials = planSubmission(process.env, command === 'plan' ? reporter : silent)
  if (command === 'plan') {
    reporter.output('submit', String(credentials !== null))
    return
  }
  if (command !== 'submit')
    throw new Error('usage: edge.ts plan | submit --zip <file> --version x.y.z')
  if (!credentials) throw new Error(`set ${SECRETS.join(', ')} first`)
  const options = parseOptions(rest)
  const version = requireOption(options, 'version')
  const zip = await readFile(
    resolve(process.env.INIT_CWD ?? process.cwd(), requireOption(options, 'zip')),
  )
  checkReleaseZip(zip, version)
  const notes = reviewerNotes(version, process.env.GITHUB_SHA)
  const { outcome, detail } = await submitToEdge(new EdgeClient(credentials), zip, notes)
  const message = `${MESSAGES[outcome](version)}${detail ? ` (${detail})` : ''}`
  if (outcome === 'submitted' || outcome === 'unchanged') reporter.notice('Edge Add-ons', message)
  else reporter.warning('Edge Add-ons', message)
  reporter.summary(`**Edge Add-ons:** ${message}`)
}

const silent: Reporter = {
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
  output: () => {},
  summary: () => {},
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  main(process.argv.slice(2), reporter).catch((error: unknown) => {
    reporter.error('Edge Add-ons', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
