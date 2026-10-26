import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePwaStore } from './pwa-store'
import {
  type AppRegistration,
  checkForUpdate,
  type RegisterSW,
  registerServiceWorker,
  UPDATE_CHECK_INTERVAL_MS,
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

/** A stand-in for a waiting service worker (only its identity matters). */
const worker = (name: string) => ({ name }) as unknown as ServiceWorker

function fakeRegistration(overrides: Partial<AppRegistration> = {}) {
  return {
    installing: null,
    waiting: null,
    update: vi.fn(async () => undefined as never),
    ...overrides,
  } satisfies AppRegistration
}

/** Hands the fake registration to the code, as `registerSW` does once the browser registered. */
function registered(sw: ReturnType<typeof fakeRegister>, registration: AppRegistration) {
  sw.options().onRegisteredSW?.('/app/sw.js', registration as unknown as ServiceWorkerRegistration)
}

const dismissed = () => usePwaStore.getState().updateDismissed

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
    registered(sw, fakeRegistration({ waiting: worker('new') }))
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

  it('reloads when another FXM window switches to the new version', () => {
    const sw = fakeRegister()
    const reload = vi.fn()
    const controllers = new EventTarget()
    registerServiceWorker(sw.register, { reload, controllers })
    sw.options().onNeedRefresh?.()
    // Even after "Not now": this page's code belongs to the old version, whose files go.
    usePwaStore.setState({ updateDismissed: true })

    // The user chose Reload in another window; the new version claims this page too.
    controllers.dispatchEvent(new Event('controllerchange'))

    expect(reload).toHaveBeenCalledOnce()
  })

  it('ignores the first visit, whose service worker takes control without a new version', () => {
    const reload = vi.fn()
    const controllers = new EventTarget()
    registerServiceWorker(fakeRegister().register, { reload, controllers })

    controllers.dispatchEvent(new Event('controllerchange'))

    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at once when the new version no longer waits', async () => {
    const sw = fakeRegister()
    const reload = vi.fn()
    registerServiceWorker(sw.register, { reload, controllers: new EventTarget() })
    const registration = fakeRegistration({ waiting: worker('new') })
    registered(sw, registration)
    sw.options().onNeedRefresh?.()

    // Another window activated it, and this page missed the takeover.
    Object.assign(registration, { waiting: null })
    await usePwaStore.getState().applyUpdate()

    expect(reload).toHaveBeenCalledOnce()
    // There is nothing left to activate.
    expect(sw.updateSW).not.toHaveBeenCalled()
  })

  it('keeps "Not now" when Workbox reports the same version again', () => {
    const sw = fakeRegister()
    registerServiceWorker(sw.register)
    registered(sw, fakeRegistration({ waiting: worker('new') }))
    // Workbox: "installed" by another window...
    sw.options().onNeedRefresh?.()
    usePwaStore.setState({ updateDismissed: true })

    // ...then "waiting", 200 ms later.
    sw.options().onNeedRefresh?.()

    expect(dismissed()).toBe(true)
    expect(usePwaStore.getState().updateReady).toBe(true)
  })

  it('offers a newer version again after the user put one off', () => {
    const sw = fakeRegister()
    registerServiceWorker(sw.register)
    const registration = fakeRegistration({ waiting: worker('v2') })
    registered(sw, registration)
    sw.options().onNeedRefresh?.()
    usePwaStore.setState({ updateDismissed: true })

    Object.assign(registration, { waiting: worker('v3') })
    sw.options().onNeedRefresh?.()

    expect(dismissed()).toBe(false)
  })

  it('knows the version that already waited when the page loaded', () => {
    const sw = fakeRegister()
    registerServiceWorker(sw.register)
    const waiting = worker('new')
    // Workbox reports a waiting version before the registration call returns.
    sw.options().onNeedRefresh?.()
    registered(sw, fakeRegistration({ waiting }))
    usePwaStore.setState({ updateDismissed: true })

    sw.options().onNeedRefresh?.()

    expect(dismissed()).toBe(true)
  })

  it('asks the site for a new version every hour while online', async () => {
    const sw = fakeRegister()
    let online = true
    registerServiceWorker(sw.register, { isOnline: () => online })
    const registration = fakeRegistration()
    registered(sw, registration)

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(registration.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(registration.update).toHaveBeenCalledOnce()

    online = false
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(registration.update).toHaveBeenCalledOnce()
  })

  it('stops checking and reloading when asked to', async () => {
    const sw = fakeRegister()
    const reload = vi.fn()
    const controllers = new EventTarget()
    const stop = registerServiceWorker(sw.register, {
      isOnline: () => true,
      reload,
      controllers,
    })
    const registration = fakeRegistration()
    registered(sw, registration)
    sw.options().onNeedRefresh?.()

    stop()
    await vi.advanceTimersByTimeAsync(3 * UPDATE_CHECK_INTERVAL_MS)
    controllers.dispatchEvent(new Event('controllerchange'))

    expect(registration.update).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('schedules nothing without a registration, or after stopping', async () => {
    const sw = fakeRegister()
    const stop = registerServiceWorker(sw.register, { isOnline: () => true })
    sw.options().onRegisteredSW?.('/app/sw.js', undefined)
    stop()
    const late = fakeRegistration()
    registered(sw, late)

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
