import { CONNECT_SEEN_KEY, createPlatform, memoryStorage } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ConnectPlatform,
  connectionContext,
  forgetConnect,
  recheckConnection,
  resetConnection,
  startConnectDetection,
  useConnection,
} from './connection'
import { connectionTier } from './explain'
import { closeTestPages, openTestPage, openTestPlatform } from './testing'

// The real platform from @fxm/platform, with a fake FXM Connect and a fake Lite sandbox.

afterEach(async () => {
  resetConnection()
  await closeTestPages()
})

const state = () => useConnection.getState()

describe('the connection store, on the real platform', () => {
  it('is Full with FXM Connect, and never runs the Lite self-test', async () => {
    const { sandbox } = await openTestPlatform({ connect: {} })
    await vi.waitFor(() => expect(state().phase).toBe('ready'))
    expect(state()).toMatchObject({
      environment: 'browser',
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true, spotify: 'anonymous' },
      connect: { state: 'present', version: '0.1.0' },
      lite: 'not-needed',
    })
    expect(connectionTier(state())).toBe('full')
    expect(sandbox.selfTests).toBe(0)
  })

  it('is Lite without FXM Connect when the self-test passes', async () => {
    const { sandbox } = await openTestPlatform({ lite: true })
    await vi.waitFor(() => expect(state().lite).toBe('passed'))
    expect(state().connect).toMatchObject({ state: 'absent' })
    expect(connectionTier(state())).toBe('lite')
    expect(sandbox.selfTests).toBe(1)
  })

  it('is Free only when the self-test fails', async () => {
    await openTestPlatform({ lite: false })
    await vi.waitFor(() => expect(state().lite).toBe('failed'))
    expect(connectionTier(state())).toBe('free')
  })

  it('is Free only while the kill switch is on, without running the self-test', async () => {
    const { sandbox } = await openTestPlatform({ lite: true, killed: true })
    await vi.waitFor(() => expect(state().phase).toBe('ready'))
    expect(state().lite).toBe('switched-off')
    expect(connectionTier(state())).toBe('free')
    expect(sandbox.selfTests).toBe(0)
  })

  it('does not use an outdated FXM Connect', async () => {
    await openTestPlatform({ connect: { version: '0.0.1' }, lite: false })
    await vi.waitFor(() => expect(state().lite).toBe('failed'))
    expect(state().connect).toMatchObject({ state: 'outdated', version: '0.0.1' })
    expect(connectionTier(state())).toBe('free')
  })

  it('notices an FXM Connect that goes missing, and falls back to Lite', async () => {
    const { connect, sandbox } = await openTestPlatform({ connect: {}, lite: true })
    await vi.waitFor(() => expect(connectionTier(state())).toBe('full'))

    connect?.uninstall()

    await vi.waitFor(() => expect(state().connect?.state).toBe('missing'))
    expect(state().connect).toMatchObject({ lastSeenVersion: '0.1.0' })
    await vi.waitFor(() => expect(state().lite).toBe('passed'))
    expect(connectionTier(state())).toBe('lite')
    expect(sandbox.selfTests).toBe(1)
  })

  it('knows FXM Connect from an earlier visit, and forgets it on request', async () => {
    const storage = memoryStorage()
    storage.setItem(CONNECT_SEEN_KEY, JSON.stringify({ version: '0.1.0', at: 1 }))
    await openTestPlatform({ storage })
    await vi.waitFor(() => expect(state().connect?.state).toBe('missing'))

    forgetConnect()

    await vi.waitFor(() => expect(state().connect?.state).toBe('absent'))
  })

  it('re-runs the Lite self-test when asked to check again', async () => {
    const { sandbox, setLite } = await openTestPlatform({ lite: false })
    await vi.waitFor(() => expect(state().lite).toBe('failed'))
    setLite(true)

    const recheck = recheckConnection()
    expect(state().rechecking).toBe(true)
    await recheck

    expect(state()).toMatchObject({ rechecking: false, lite: 'passed' })
    expect(connectionTier(state())).toBe('lite')
    expect(sandbox.selfTests).toBe(2)
  })

  it('checks again without spending a self-test when FXM Connect gives full access', async () => {
    const { sandbox } = await openTestPlatform({ connect: {} })
    await vi.waitFor(() => expect(state().phase).toBe('ready'))
    await recheckConnection()
    expect(sandbox.selfTests).toBe(0)
    expect(connectionTier(state())).toBe('full')
  })

  it('follows the request budget', async () => {
    await openTestPlatform({ lite: true })
    await vi.waitFor(() => expect(state().lite).toBe('passed'))
    // The self-test drew one slot.
    expect(state().budget).toMatchObject({ used: 1, hourlyLimit: 600 })
  })

  it('builds provider contexts from the bound platform', async () => {
    await openTestPlatform({ lite: true })
    await vi.waitFor(() => expect(state().lite).toBe('passed'))
    const ctx = connectionContext('music')
    expect(ctx).toMatchObject({
      platform: 'web',
      mode: 'music',
      capabilities: { youtube: 'simple' },
    })
    expect(typeof ctx?.fetch).toBe('function')
  })
})

describe('startConnectDetection', () => {
  it('detects while the platform is created, then binds it, once', async () => {
    let finish: (platform: ConnectPlatform) => void = () => {}
    const create = vi.fn(() => new Promise<ConnectPlatform>((resolve) => (finish = resolve)))
    const started = startConnectDetection(create)
    expect(state().phase).toBe('detecting')
    expect(startConnectDetection(create)).toBe(started)

    finish(
      await createPlatform({
        environment: 'browser',
        window: openTestPage(),
        storage: memoryStorage(),
      }),
    )
    await started

    expect(create).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ phase: 'ready', lite: 'unavailable' })
    expect(connectionTier(state())).toBe('free')
  })

  it("ends in `failed` when the platform can't be created", async () => {
    await startConnectDetection(() => Promise.reject(new Error('No browser window to run in')))
    expect(state()).toMatchObject({ phase: 'failed', error: 'No browser window to run in' })
  })
})
