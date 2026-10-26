/**
 * FXM's releases on GitHub, as the Android app's update check reads them (stage 6.6): the newest
 * published release, its version and whether it has the APK. It asks GitHub's public REST API
 * without a token or cookies; CLEAN-ROOM.md lists the facts it relies on. The links it offers are
 * built here from the version, never taken from the answer.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import type { UpdateFetch } from '@fxm/platform'

/** The repository whose releases the release workflow publishes. */
export const RELEASES_REPOSITORY = 'Pratyay-ops/FXM'

/** GitHub's "latest release": the newest one that is neither a draft nor a pre-release. */
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`

/** How long a check may take. */
export const RELEASE_CHECK_TIMEOUT_MS = 15_000

/** The newest published release, as far as the update check needs it. */
export interface AppRelease {
  /** Its version, x.y.z (the tag without its `v`). */
  readonly version: string
  /** When GitHub published it (ISO 8601), if it says. */
  readonly publishedAt?: string
  /** Whether it carries the universal APK ({@link apkFileName}). */
  readonly hasApk: boolean
}

/** A release version: x.y.z with each number up to 65535, as scripts/release-lib.sh allows. */
const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/

/** The three numbers of an x.y.z version, or `undefined` for anything else. */
export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = VERSION.exec(version)
  if (match === null) return undefined
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return parts.every((part) => part <= 65_535) ? parts : undefined
}

/** Whether `candidate` is a higher x.y.z version than `current`. False if either isn't one. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (a === undefined || b === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return false
}

/** The universal APK of a version, as the release workflow names it (scripts/release-lib.sh). */
export function apkFileName(version: string): string {
  return `fxm-android-universal-${version}.apk`
}

/** The page of a release on GitHub, with its notes, files and the signing certificate. */
export function releasePageUrl(version: string): string {
  return `https://github.com/${RELEASES_REPOSITORY}/releases/tag/v${version}`
}

/** Where a release's universal APK downloads from. */
export function apkDownloadUrl(version: string): string {
  return `https://github.com/${RELEASES_REPOSITORY}/releases/download/v${version}/${apkFileName(version)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads GitHub's answer for the latest release.
 *
 * @throws FxmError `Parse` when it isn't a published release with an x.y.z tag (`vX.Y.Z`).
 */
export function parseLatestRelease(answer: unknown): AppRelease {
  if (!isRecord(answer)) throw new FxmError('Parse', 'GitHub sent no release object')
  if (answer.draft === true || answer.prerelease === true) {
    throw new FxmError('Parse', 'GitHub named a draft or a pre-release as the latest release')
  }
  const tag = typeof answer.tag_name === 'string' ? answer.tag_name : ''
  const version = tag.startsWith('v') ? tag.slice(1) : ''
  if (parseVersion(version) === undefined) {
    throw new FxmError('Parse', `The latest release's tag is not vX.Y.Z: ${JSON.stringify(tag)}`)
  }
  const assets = Array.isArray(answer.assets) ? answer.assets : []
  const hasApk = assets.some(
    (asset) =>
      isRecord(asset) &&
      asset.name === apkFileName(version) &&
      // A file that is still being uploaded, or failed to, isn't offered.
      (asset.state === undefined || asset.state === 'uploaded'),
  )
  const publishedAt =
    typeof answer.published_at === 'string' && !Number.isNaN(Date.parse(answer.published_at))
      ? answer.published_at
      : undefined
  return { version, hasApk, ...(publishedAt === undefined ? {} : { publishedAt }) }
}

/**
 * Asks GitHub for FXM's newest published release: one GET request, without a token or cookies,
 * that follows no redirect, gives up after {@link RELEASE_CHECK_TIMEOUT_MS}, and stops when
 * `signal` aborts. Resolves `undefined` while FXM has published no release.
 *
 * @throws FxmError `RateLimited` when GitHub's hourly limit for this address is used up (with the
 * wait, when GitHub says), `Network` when GitHub can't be reached or answers with another error,
 * and `Parse` for an answer that isn't a release ({@link parseLatestRelease}).
 */
export async function fetchLatestRelease(
  fetch: UpdateFetch,
  { signal, now = Date.now }: { signal?: AbortSignal; now?: () => number } = {},
): Promise<AppRelease | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS)
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop)
  if (signal?.aborted) stop()
  let response: Response
  let answer: unknown
  try {
    response = await fetch(LATEST_RELEASE_URL, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      // GitHub's error answers are a few bytes of JSON: read them, so the connection is done.
      await response.text().catch(() => '')
      if (response.status === 404) return undefined
      throw httpError(response, now())
    }
    answer = await response.json().catch((cause: unknown) => {
      // Only text that isn't JSON; a connection lost while reading is a network failure.
      if (!(cause instanceof SyntaxError)) throw cause
      throw new FxmError('Parse', 'GitHub answered the update check with something not JSON', {
        cause,
      })
    })
  } catch (cause) {
    if (cause instanceof FxmError) throw cause
    throw new FxmError('Network', 'Could not reach GitHub to check for updates', { cause })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
  return parseLatestRelease(answer)
}

/** The error for an HTTP error from GitHub's API. */
function httpError(response: Response, now: number): FxmError {
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (response.status === 429 || (response.status === 403 && remaining === '0')) {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const retryAfter = Number(response.headers.get('retry-after'))
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? Math.max(0, reset * 1000 - now)
          : undefined
    return new FxmError(
      'RateLimited',
      `GitHub's limit of requests for this address is used up (HTTP ${response.status})`,
      retryAfterMs === undefined ? {} : { retryAfterMs },
    )
  }
  return new FxmError('Network', `GitHub answered the update check with HTTP ${response.status}`)
}
