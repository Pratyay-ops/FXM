import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePwaStore } from './pwa-store'
import {
  checkForUpdate,
  type RegisterSW,
  registerServiceWorker,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdatableRegistration,
} from './service-worker'

/** A `registerSW` that records its options and the reloads it was asked for. */
function fakeRegister() {
  const calls: RegisterSWOptions[] = []
  const updateSW = vi.fn(async () => {})
  const register: RegisterSW = (options = {}) => {
    calls.push(options)
    return updateSW
  }
  const options = () => {
    const last = calls.at(-1)
    if (last === undefined) throw new Error('registerSW was not called')
    return last
  }
  return { register, options, updateSW, calls }
}

function fakeRegistration(overrides: Partial<UpdatableRegistration> = {}) {
  return {
    installing: null,
    update: vi.fn(async () => undefined as never),
    ...overrides,
  } satisfies UpdatableRegistration
}

describe('registerServiceWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers once, when the page has loaded', () => {
    const sw = fakeRegister()
    registerServiceWorker(sw.register)
    expect(sw.calls).toHaveLength(1)
    // `immediate` would compete with the page's own downloads.
    expect(sw.options().immediate).toBeUndefined()
  })

  it('shows the update toast when a new version waits, and reloads into it on request', async () => {
    const sw = fakeRegister()
    const reload = vi.fn()
    const controllers = new EventTarget()
    registerServiceWorker(sw.register, { reload, controllers })
    expect(usePwaStore.getState().updateReady).toBe(false)

    sw.options().onNeedRefresh?.()
    expect(usePwaStore.getState()).toMatchObject({ updateReady: true, updateDismissed: false })

    await usePwaStore.getState().applyUpdate()
    expect(sw.updateSW).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()

    // The waiting version takes over the page.
    controllers.dispatchEvent(new Event('controllerchange'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads once, whoever reports the new version taking over', async () => {
    const sw = fakeRegister()
    const reload = vi.fn()
    const controllers = new EventTarget()
    registerServiceWorker(sw.register, { reload, controllers })
    sw.options().onNeedRefresh?.()

    await usePwaStore.getState().applyUpdate()
    sw.options().onNeedReload?.()
    controllers.dispatchEvent(new Event('controllerchange'))

    expect(reload).toHaveBeenCalledOnce()
  })

  it('ignores a takeover before the user asked for the new version', () => {
    const reload = vi.fn()
    const controllers = new EventTarget()
    registerServiceWorker(fakeRegister().register, { reload, controllers })

    // The first visit: the service worker takes control of the page it was installed from.
    controllers.dispatchEvent(new Event('controllerchange'))

    expect(reload).not.toHaveBeenCalled()
  })

  it('offers a newer version again after the user put one off', () => {
    const sw = fakeRegister()
    registerServiceWorker(sw.register)
    sw.options().onNeedRefresh?.()
    usePwaStore.setState({ updateDismissed: true })

    sw.options().onNeedRefresh?.()

    expect(usePwaStore.getState().updateDismissed).toBe(false)
  })

  it('asks the site for a new version every hour while online', async () => {
    const sw = fakeRegister()
    let online = true
    registerServiceWorker(sw.register, { isOnline: () => online })
    const registration = fakeRegistration()
    sw.options().onRegisteredSW?.(
      '/app/sw.js',
      registration as unknown as ServiceWorkerRegistration,
    )

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(registration.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(registration.update).toHaveBeenCalledOnce()

    online = false
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(registration.update).toHaveBeenCalledOnce()
  })

  it('stops checking when asked to', async () => {
    const sw = fakeRegister()
    const stop = registerServiceWorker(sw.register, { isOnline: () => true })
    const registration = fakeRegistration()
    sw.options().onRegisteredSW?.(
      '/app/sw.js',
      registration as unknown as ServiceWorkerRegistration,
    )

    stop()
    await vi.advanceTimersByTimeAsync(3 * UPDATE_CHECK_INTERVAL_MS)

    expect(registration.update).not.toHaveBeenCalled()
  })

  it('schedules nothing without a registration, or after stopping', async () => {
    const sw = fakeRegister()
    const stop = registerServiceWorker(sw.register, { isOnline: () => true })
    sw.options().onRegisteredSW?.('/app/sw.js', undefined)
    stop()
    const late = fakeRegistration()
    sw.options().onRegisteredSW?.('/app/sw.js', late as unknown as ServiceWorkerRegistration)

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)

    expect(late.update).not.toHaveBeenCalled()
  })

  it('keeps the app working when the service worker fails to register', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sw = fakeRegister()
    registerServiceWorker(sw.register)

    sw.options().onRegisterError?.(new Error('SecurityError'))

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/works online/), expect.any(Error))
    expect(usePwaStore.getState().updateReady).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('asks the registration to update', async () => {
    const registration = fakeRegistration()
    await checkForUpdate(registration, () => true)
    expect(registration.update).toHaveBeenCalledOnce()
  })

  it('skips the check offline, or while a new version installs', async () => {
    const offline = fakeRegistration()
    await checkForUpdate(offline, () => false)
    expect(offline.update).not.toHaveBeenCalled()

    const installing = fakeRegistration({ installing: {} as ServiceWorker })
    await checkForUpdate(installing, () => true)
    expect(installing.update).not.toHaveBeenCalled()
  })

  it('shrugs off a site that cannot be reached', async () => {
    const registration = fakeRegistration({
      update: vi.fn(async () => {
        throw new TypeError('Failed to update a ServiceWorker')
      }),
    })
    await expect(checkForUpdate(registration, () => true)).resolves.toBeUndefined()
  })
})
