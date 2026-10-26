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

  it('but at most a day, so a long wait never reads as a clock that went back', async () => {
    const { fetch } = fakeUpdateFetch(
      jsonResponse(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 429, headers: { 'retry-after': String(3 * 24 * 3600) } },
      ),
    )
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    const { nextCheckAt } = store.getState()
    expect(nextCheckAt).toBe(NOW + CHECK_INTERVAL_MS)
    expect(isCheckDue(nextCheckAt, NOW)).toBe(false)
  })

  it('says when GitHub’s answer makes no sense', async () => {
    const { fetch } = fakeUpdateFetch(jsonResponse({ tag_name: 'latest' }))
    await checkForAppUpdate({ store, fetch, now: () => NOW })
    expect(store.getState().problem).toBe('unexpected')
  })

  it('asks nothing while the device is offline, and is due as soon as it is online', async () => {
    const { fetch, calls } = fakeUpdateFetch()
    // The last check was an hour ago, so the next scheduled one is nearly a day away.
    store.setState({
      lastCheckedAt: NOW - 3600_000,
      nextCheckAt: NOW + CHECK_INTERVAL_MS - 3600_000,
    })
    await checkForAppUpdate({ store, fetch, now: () => NOW, isOnline: () => false })
    expect(calls).toHaveLength(0)
    expect(store.getState()).toMatchObject({ problem: 'offline', nextCheckAt: NOW })
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

  it('backs off after a rate limit, also when the device’s clock is days behind GitHub’s', async () => {
    vi.useFakeTimers({ now: NOW })
    // GitHub's reset is absolute: on a clock two days behind, it looks two days away.
    const reset = String(NOW / 1000 + 2 * 24 * 3600 + 600)
    const { fetch, calls } = fakeUpdateFetch(
      jsonResponse(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
      ),
      jsonResponse(releaseAnswer('0.6.0')),
    )
    const { page, network } = events()
    const stop = startAppUpdateChecks({ support: ANDROID, store, fetch, page, network })
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(calls).toHaveLength(1)
    expect(store.getState().problem).toBe('rate-limited')
    // Every look, return to the foreground and reconnection of the next hours asks nothing.
    for (let hour = 0; hour < 6; hour += 1) {
      page.dispatchEvent(new Event('visibilitychange'))
      network.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(3600_000)
    }
    expect(calls).toHaveLength(1)
    // A day later it asks again.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(calls).toHaveLength(2)
    expect(store.getState().problem).toBeNull()
    stop()
  })

  it('checks once the device is online again after a check that found it offline', async () => {
    vi.useFakeTimers({ now: NOW })
    let online = true
    const { page, network } = events()
    const { fetch, calls } = fakeUpdateFetch(
      jsonResponse(releaseAnswer('0.5.0')),
      jsonResponse(releaseAnswer('0.6.0')),
    )
    const options = { support: ANDROID, store, fetch, page, network, isOnline: () => online }
    const stop = startAppUpdateChecks(options)
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(calls).toHaveLength(1)
    // "Check now" an hour later, offline: nothing is asked.
    await vi.advanceTimersByTimeAsync(3600_000)
    online = false
    await checkForAppUpdate(options)
    expect(calls).toHaveLength(1)
    expect(store.getState().problem).toBe('offline')
    online = true
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    expect(store.getState()).toMatchObject({ problem: null, latest: { version: '0.6.0' } })
    // And then no more than once a day again.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - DUE_CHECK_INTERVAL_MS)
    expect(calls).toHaveLength(2)
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
