import { isFxmError } from '@fxm/core'
import type { UpdateFetch } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apkDownloadUrl,
  apkFileName,
  fetchLatestRelease,
  isNewerVersion,
  LATEST_RELEASE_URL,
  parseLatestRelease,
  parseVersion,
  RELEASE_CHECK_TIMEOUT_MS,
  releasePageUrl,
} from './releases'
import { fakeUpdateFetch, jsonResponse, releaseAnswer } from './testing'

const fakeFetch = fakeUpdateFetch
const json = jsonResponse

afterEach(() => {
  vi.useRealTimers()
})

describe('versions', () => {
  it('reads x.y.z with numbers up to 65535, and nothing else', () => {
    expect(parseVersion('0.5.0')).toEqual([0, 5, 0])
    expect(parseVersion('65535.0.1')).toEqual([65535, 0, 1])
    for (const bad of [
      'v0.5.0',
      '0.5',
      '0.5.0.1',
      '0.5.0-rc.1',
      '00.5.0',
      '65536.0.0',
      '',
      ' 0.5.0',
    ]) {
      expect(parseVersion(bad), bad).toBeUndefined()
    }
  })

  it('compares them as numbers', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.5.1', '0.5.0')).toBe(true)
    expect(isNewerVersion('0.5.0', '0.5.0')).toBe(false)
    expect(isNewerVersion('0.4.9', '0.5.0')).toBe(false)
    expect(isNewerVersion('garbage', '0.5.0')).toBe(false)
    expect(isNewerVersion('0.6.0', 'garbage')).toBe(false)
  })
})

describe('links', () => {
  it('point at the release workflow’s files on GitHub, built from the version alone', () => {
    expect(apkDownloadUrl('0.6.0')).toBe(
      'https://github.com/Pratyay-ops/FXM/releases/download/v0.6.0/fxm-android-universal-0.6.0.apk',
    )
    expect(releasePageUrl('0.6.0')).toBe('https://github.com/Pratyay-ops/FXM/releases/tag/v0.6.0')
  })
})

describe('parseLatestRelease', () => {
  it('reads the version and whether the universal APK is there', () => {
    expect(parseLatestRelease(releaseAnswer('0.6.0'))).toEqual({
      version: '0.6.0',
      hasApk: true,
      publishedAt: '2026-11-02T10:00:00Z',
    })
    expect(parseLatestRelease(releaseAnswer('0.6.0', { apk: false })).hasApk).toBe(false)
  })

  it('offers no APK that is still uploading, or another version’s', () => {
    expect(parseLatestRelease(releaseAnswer('0.6.0', { state: 'starter' })).hasApk).toBe(false)
    const answer = releaseAnswer('0.6.0', { apk: false })
    answer.assets.push({ name: apkFileName('0.5.0'), state: 'uploaded' })
    expect(parseLatestRelease(answer).hasApk).toBe(false)
  })

  it('leaves out a publication date it can’t read', () => {
    expect(parseLatestRelease({ ...releaseAnswer('0.6.0'), published_at: 'soon' })).toEqual({
      version: '0.6.0',
      hasApk: true,
    })
  })

  it.each([
    ['not an object', 'v0.6.0'],
    ['a tag without the v', { ...releaseAnswer('0.6.0'), tag_name: '0.6.0' }],
    ['another kind of tag', { ...releaseAnswer('0.6.0'), tag_name: 'nightly' }],
    ['a draft', { ...releaseAnswer('0.6.0'), draft: true }],
    ['a pre-release', { ...releaseAnswer('0.6.0'), prerelease: true }],
  ])('refuses %s', (_name, answer) => {
    let error: unknown
    try {
      parseLatestRelease(answer)
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Parse')).toBe(true)
  })
})

describe('fetchLatestRelease', () => {
  it('asks GitHub’s API once, without cookies, following no redirect', async () => {
    const { fetch, calls } = fakeFetch(json(releaseAnswer('0.6.0')))
    await expect(fetchLatestRelease(fetch)).resolves.toMatchObject({ version: '0.6.0' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(LATEST_RELEASE_URL)
    expect(LATEST_RELEASE_URL).toBe('https://api.github.com/repos/Pratyay-ops/FXM/releases/latest')
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' })
  })

  it('resolves undefined while FXM has published no release', async () => {
    const { fetch } = fakeFetch(json({ message: 'Not Found' }, { status: 404 }))
    await expect(fetchLatestRelease(fetch)).resolves.toBeUndefined()
  })

  it('reports GitHub’s rate limit with the wait it names', async () => {
    const now = Date.UTC(2026, 10, 2, 10, 0, 0)
    const reset = String(now / 1000 + 1800)
    const { fetch } = fakeFetch(
      json(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
      ),
      json({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '60' } }),
    )
    const limited = await fetchLatestRelease(fetch, { now: () => now }).catch((error) => error)
    expect(isFxmError(limited, 'RateLimited')).toBe(true)
    expect(limited.retryAfterMs).toBe(1_800_000)
    const slowed = await fetchLatestRelease(fetch, { now: () => now }).catch((error) => error)
    expect(isFxmError(slowed, 'RateLimited')).toBe(true)
    expect(slowed.retryAfterMs).toBe(60_000)
  })

  it('reports other errors and failures as network problems', async () => {
    const { fetch } = fakeFetch(
      json({}, { status: 502 }),
      json({ message: 'Forbidden' }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } }),
      new TypeError('Failed to fetch'),
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await fetchLatestRelease(fetch).catch((caught) => caught)
      expect(isFxmError(error, 'Network')).toBe(true)
    }
  })

  it('reports an answer that isn’t a release as unreadable', async () => {
    const { fetch } = fakeFetch(
      new Response('<html>not json</html>', { status: 200 }),
      json({ tag_name: 'latest' }),
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await fetchLatestRelease(fetch).catch((caught) => caught)
      expect(isFxmError(error, 'Parse')).toBe(true)
    }
  })

  it('gives up after its time limit, and when the caller cancels', async () => {
    vi.useFakeTimers()
    const hanging: UpdateFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    const timedOut = fetchLatestRelease(hanging).catch((error) => error)
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_TIMEOUT_MS)
    expect(isFxmError(await timedOut, 'Network')).toBe(true)

    const caller = new AbortController()
    const cancelled = fetchLatestRelease(hanging, { signal: caller.signal }).catch((error) => error)
    caller.abort()
    expect(isFxmError(await cancelled, 'Network')).toBe(true)
  })
})
