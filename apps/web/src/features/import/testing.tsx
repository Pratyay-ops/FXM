/**
 * Test helpers for the import pages: fake services over the fake YouTube Music catalog of
 * `@fxm/sources/import/testing`, and the app rendered with them. Only tests import this module.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import { AUTO_AVAILABLE, fakeYouTube, testContext } from '@fxm/sources/import/testing'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { App } from '../../app/app'
import { routes } from '../../app/routes'
import { type ImportLockManager, importLockName } from './locks'
import type { ImportServices } from './services'
import { ImportServicesProvider } from './services'

/** A fake Web Locks manager, with locks other tabs hold. */
export interface FakeLocks extends ImportLockManager {
  /** The imports another tab holds the lock of. */
  elsewhere: Set<string>
  /** Whether `query()` reports the other tabs' locks (a tab that took one just now may not). */
  reportElsewhere: boolean
}

/**
 * A Web Locks manager for tests: this tab's requests take turns per name, and the locks of the
 * imports in `elsewhere` are never granted, as when another tab holds them.
 */
export function fakeLocks(elsewhere: Iterable<string> = []): FakeLocks {
  const queues = new Map<string, Promise<void>>()
  const mine = new Map<string, number>()
  const locks: FakeLocks = {
    elsewhere: new Set(elsewhere),
    reportElsewhere: true,
    async request(name, options, callback) {
      if ([...locks.elsewhere].some((id) => importLockName(id) === name)) {
        return new Promise((_, reject) => {
          const fail = () => reject(new DOMException('The lock was not granted', 'AbortError'))
          if (options.signal?.aborted) fail()
          else options.signal?.addEventListener('abort', fail, { once: true })
        })
      }
      const previous = queues.get(name) ?? Promise.resolve()
      let release: () => void = () => {}
      const turn = new Promise<void>((resolve) => {
        release = resolve
      })
      queues.set(
        name,
        previous.then(() => turn),
      )
      await previous
      mine.set(name, (mine.get(name) ?? 0) + 1)
      try {
        return await callback({ name })
      } finally {
        const left = (mine.get(name) ?? 1) - 1
        if (left > 0) mine.set(name, left)
        else mine.delete(name)
        release()
      }
    },
    async query() {
      const others = locks.reportElsewhere ? [...locks.elsewhere].map(importLockName) : []
      return { held: [...others, ...mine.keys()].map((name) => ({ name })) }
    },
  }
  return locks
}

/** Fake services, and what they saw. */
export interface FakeServices extends ImportServices {
  /** How many bulk slots were waited for. */
  slots: number
  /** The errors reported to the platform. */
  reported: unknown[]
}

/** Services whose budget hands out slots at once, over an empty fake catalog by default. */
export function fakeServices(
  overrides: Partial<ImportServices> & { capabilities?: () => NetworkCapabilities } = {},
): FakeServices {
  const services: FakeServices = {
    slots: 0,
    reported: [],
    context: (mode, signal) => testContext(mode, signal),
    async waitForBulkSlot(signal) {
      signal.throwIfAborted()
      services.slots++
    },
    nextBulkSlotAt: () => 0,
    report(error) {
      services.reported.push(error)
    },
    capabilities: () => ({
      youtube: 'full',
      spotify: 'anonymous',
      mediaBytes: true,
      fileSystem: false,
    }),
    subscribeCapabilities: () => () => {},
    matching: () => (services.capabilities().youtube === 'none' ? 'needs-connect' : 'ready'),
    isOnline: () => true,
    youtube: fakeYouTube(),
    spotify: undefined,
    musicBrainz: undefined,
    autoMatch: () => true,
    // The Auto band available, so that the setting counts (FXM's own config keeps it off).
    matchingConfig: AUTO_AVAILABLE,
    ...overrides,
  }
  return services
}

/** Renders the whole app at `path`, with `services` as the import services. */
export function renderWithServices(path: string, services: ImportServices) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const user = userEvent.setup()
  return {
    user,
    router,
    ...render(
      <ImportServicesProvider value={services}>
        <App router={router} />
      </ImportServicesProvider>,
    ),
  }
}
