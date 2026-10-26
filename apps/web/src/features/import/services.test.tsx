import { YOUTUBE_IMPORT_UNAVAILABLE } from '@fxm/sources/import'
import { testContext } from '@fxm/sources/import/testing'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import {
  createImportServices,
  type ImportServiceParts,
  ImportServicesProvider,
  useImportServices,
} from './services'
import { fakeServices } from './testing'

function fakePlatform() {
  const calls: unknown[][] = []
  const platform: ImportServiceParts['platform'] = {
    context: (options) => {
      calls.push(['context', options])
      return testContext(options.mode)
    },
    report: (error) => {
      calls.push(['report', error])
      return true
    },
    budget: {
      whenAvailable: async (priority: string, options: unknown) => {
        calls.push(['whenAvailable', priority, options])
      },
      nextSlotAt: (priority: string) => {
        calls.push(['nextSlotAt', priority])
        return 42
      },
    } as unknown as ImportServiceParts['platform']['budget'],
    capabilities: {
      current: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
    } as unknown as ImportServiceParts['platform']['capabilities'],
  }
  return { platform, calls }
}

describe('createImportServices', () => {
  it('draws on the platform’s bulk priority for everything an import does', async () => {
    const { platform, calls } = fakePlatform()
    const services = createImportServices({ platform, youtube: YOUTUBE_IMPORT_UNAVAILABLE })
    const signal = new AbortController().signal
    expect(services.context('all', signal).mode).toBe('all')
    await services.waitForBulkSlot(signal)
    expect(services.nextBulkSlotAt()).toBe(42)
    const error = new Error('x')
    services.report(error)
    expect(calls).toEqual([
      ['context', { mode: 'all', priority: 'bulk', signal }],
      ['whenAvailable', 'bulk', { signal }],
      ['nextSlotAt', 'bulk'],
      ['report', error],
    ])
    expect(services.capabilities().youtube).toBe('simple')
    // Auto matching stays off until stage 1.12 turns it on.
    expect(services.autoMatch()).toBe(false)
    expect(services.spotify).toBeUndefined()
  })
})

describe('useImportServices', () => {
  it('hands out the services a provider gives, without creating the app’s', async () => {
    const given = fakeServices()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ImportServicesProvider value={given}>{children}</ImportServicesProvider>
    )
    const { result } = renderHook(() => useImportServices(), { wrapper })
    expect(result.current.current).toBe(given)
    await expect(result.current.get()).resolves.toBe(given)
  })

  it('creates nothing before an import asks for it', () => {
    const { result } = renderHook(() => useImportServices())
    expect(result.current.current).toBeUndefined()
  })
})
