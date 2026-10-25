/**
 * Test helpers for the import pages: fake services over the fake YouTube Music catalog of
 * `@fxm/sources/import/testing`, and the app rendered with them. Only tests import this module.
 *
 * @module
 */

import type { NetworkCapabilities } from '@fxm/core'
import { fakeYouTube, testContext } from '@fxm/sources/import/testing'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { App } from '../../app/app'
import { routes } from '../../app/routes'
import type { ImportServices } from './services'
import { ImportServicesProvider } from './services'

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
    youtube: fakeYouTube(),
    spotify: undefined,
    musicBrainz: undefined,
    autoMatch: () => true,
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
