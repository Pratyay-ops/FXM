import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_UPDATE_STORAGE_KEY, sanitizeAppUpdate } from './app-update-store'
import {
  CHECK_INTERVAL_MS,
  checkForAppUpdate,
  DUE_CHECK_INTERVAL_MS,
  dismissAppUpdate,
  FIRST_CHECK_DELAY_MS,
  isCheckDue,
  RETRY_INTERVAL_MS,
  startAppUpdateChecks,
} from './checks'
import { LATEST_RELEASE_URL } from './releases'
import { fakeUpdateFetch, jsonResponse, releaseAnswer, testAppUpdateStore } from './testing'

const NOW = Date.UTC(2026, 10, 2, 10, 0, 0)
const ANDROID = { checks: true, version: '0.5.0' } as const

let store = testAppUpdateStore()
beforeEach(() => {
  store = testAppUpdateStore()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('checkForAppUpdate', () => {
  it('records the newest release and schedules the next check a day later', async () => {
    const { fetch, calls } = fakeUpdateFetch(jsonResponse(releaseAnswer('0.6.0')))
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(calls.map((call) => call.url)).toEqual([LATEST_RELEASE_URL])
    expect(store.getState()).toMatchObject({
      latest: { version: '0.6.0', hasApk: true },
      lastCheckedAt: NOW,
      nextCheckAt: NOW + CHECK_INTERVAL_MS,
      checking: false,
      problem: null,
    })
  })

  it('records that nothing is published yet', async () => {
    const { fetch } = fakeUpdateFetch(jsonResponse({ message: 'Not Found' }, { status: 404 }))
    store.setState({ latest: { version: '0.6.0', hasApk: true } })
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState()).toMatchObject({ latest: null, lastCheckedAt: NOW, problem: null })
  })

  it('keeps what it found before when a check fails, and tries again in an hour', async () => {
    const { fetch } = fakeUpdateFetch(new TypeError('Failed to fetch'))
    store.setState({ latest: { version: '0.6.0', hasApk: true }, lastCheckedAt: 1 })
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState()).toMatchObject({
      latest: { version: '0.6.0' },
      lastCheckedAt: 1,
      nextCheckAt: NOW + RETRY_INTERVAL_MS,
      problem: 'unreachable',
      checking: false,
    })
  })

  it('waits as long as GitHub’s rate limit asks, at least an hour', async () => {
    const reset = String(NOW / 1000 + 3 * 3600)
    const { fetch } = fakeUpdateFetch(
      jsonResponse(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
      ),
    )
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState()).toMatchObject({
      problem: 'rate-limited',
      nextCheckAt: NOW + 3 * 3600_000,
    })
  })

  it('says when GitHub’s answer makes no sense', async () => {
    const { fetch } = fakeUpdateFetch(jsonResponse({ tag_name: 'latest' }))
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState().problem).toBe('unexpected')
  })

  it('asks nothing while the device is offline', async () => {
    const { fetch, calls } = fakeUpdateFetch()
    await checkForAppUpdate({ store, fetch, now: () => NOW, isOnline: () => false })
    expect(calls).toHaveLength(0)
    expect(store.getState().problem).toBe('offline')
  })

  it('runs one check at a time, which every caller shares', async () => {
    let answer: (response: Response) => void = () => {}
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)))
    const first = checkForAppUpdate({ store, fetch, now: () => NOW })
    const second = checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState().checking).toBe(true)
    answer(jsonResponse(releaseAnswer('0.6.0')))
    await Promise.all([first, second])
    expect(fetch).toHaveBeenCalledOnce()
    expect(store.getState().checking).toBe(false)
  })
})

describe('isCheckDue', () => {
  it('is due once the time comes, and when the clock went back a long way', () => {
    expect(isCheckDue(0, NOW)).toBe(true)
    expect(isCheckDue(NOW, NOW)).toBe(true)
    expect(isCheckDue(NOW + 1, NOW)).toBe(false)
    expect(isCheckDue(NOW + CHECK_INTERVAL_MS, NOW)).toBe(false)
    expect(isCheckDue(NOW + CHECK_INTERVAL_MS + 1, NOW)).toBe(true)
  })
})

describe('startAppUpdateChecks', () => {
  /** A page and a network whose events the test sends. */
  function events() {
    const page = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    })
    return { page, network: new EventTarget() }
  }

  it('does nothing in builds that don’t check', async () => {
    vi.useFakeTimers({ now: NOW })
    const { fetch, calls } = fakeUpdateFetch(jsonResponse(releaseAnswer('0.6.0')))
    for (const reason of ['not-android', 'fdroid', 'unreleased'] as const) {
      const stop = startAppUpdateChecks({
        support: { checks: false, reason },
        store,
        fetch,
        ...events(),
      })
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
      stop()
    }
    expect(calls).toHaveLength(0)
  })

  it('checks a while after start-up, then once a day', async () => {
    vi.useFakeTimers({ now: NOW })
    const { fetch, calls } = fakeUpdateFetch(
      jsonResponse(releaseAnswer('0.6.0')),
      jsonResponse(releaseAnswer('0.6.1')),
    )
    const stop = startAppUpdateChecks({ support: ANDROID, store, fetch, ...events() })
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    // Due a day after the first check, which the next look every 15 minutes finds.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - DUE_CHECK_INTERVAL_MS)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * DUE_CHECK_INTERVAL_MS)
    expect(calls).toHaveLength(2)
    expect(store.getState().latest?.version).toBe('0.6.1')
    stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(calls).toHaveLength(2)
  })

  it('waits for the next check that is due, also across restarts', async () => {
    vi.useFakeTimers({ now: NOW })
    store.setState({ nextCheckAt: NOW + 3600_000 })
    const { fetch, calls } = fakeUpdateFetch(jsonResponse(releaseAnswer('0.6.0')))
    const stop = startAppUpdateChecks({ support: ANDROID, store, fetch, ...events() })
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(calls).toHaveLength(1)
    stop()
  })

  it('checks when the app comes back to the foreground or the device goes online, if due', async () => {
    vi.useFakeTimers({ now: NOW })
    const { page, network } = events()
    const { fetch, calls } = fakeUpdateFetch(
      jsonResponse(releaseAnswer('0.6.0')),
      jsonResponse(releaseAnswer('0.6.0')),
    )
    const stop = startAppUpdateChecks({ support: ANDROID, store, fetch, page, network })
    page.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(calls).toHaveLength(0)
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    vi.setSystemTime(NOW + FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS)
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    stop()
  })
})

describe('the stored state', () => {
  it('keeps what the last check found across restarts', async () => {
    const { fetch } = fakeUpdateFetch(jsonResponse(releaseAnswer('0.6.0')))
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    dismissAppUpdate('0.6.0', store)
    await store.persist.rehydrate()
    expect(store.getState()).toMatchObject({
      latest: { version: '0.6.0', hasApk: true },
      lastCheckedAt: NOW,
      nextCheckAt: NOW + CHECK_INTERVAL_MS,
      dismissedVersion: '0.6.0',
      checking: false,
    })
    expect(APP_UPDATE_STORAGE_KEY).toBe('fxm.app-update.v1')
  })

  it('drops whatever isn’t valid', () => {
    expect(sanitizeAppUpdate('garbage')).toEqual({
      latest: null,
      lastCheckedAt: 0,
      nextCheckAt: 0,
      dismissedVersion: null,
    })
    expect(
      sanitizeAppUpdate({
        latest: { version: 'v1', hasApk: true },
        lastCheckedAt: -5,
        nextCheckAt: Number.NaN,
        dismissedVersion: 'x',
      }),
    ).toEqual({ latest: null, lastCheckedAt: 0, nextCheckAt: 0, dismissedVersion: null })
    expect(
      sanitizeAppUpdate({ latest: { version: '0.6.0', hasApk: 'yes', publishedAt: 3 } }).latest,
    ).toEqual({ version: '0.6.0', hasApk: false })
  })
})
