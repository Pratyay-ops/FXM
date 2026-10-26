import type { ProviderContext } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appContext, connectAppContext } from './app-context'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appContext', () => {
  it("uses the page's own fetch, without cookies, until the platform's is connected", async () => {
    const fetch = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', fetch)

    const ctx = appContext('music')
    await ctx.fetch('https://lrclib.net/api/get', { method: 'GET' })

    expect(fetch).toHaveBeenCalledWith('https://lrclib.net/api/get', {
      method: 'GET',
      credentials: 'omit',
    })
    expect(ctx.capabilities.youtube).toBe('none')
  })

  it("takes the connected platform's context, until it is disconnected", () => {
    const platform = { platform: 'desktop' } as ProviderContext
    const source = vi.fn(() => platform)
    const signal = new AbortController().signal
    const disconnect = connectAppContext(source)

    expect(appContext('all', signal)).toBe(platform)
    expect(source).toHaveBeenCalledWith({ mode: 'all', signal })
    disconnect()
    expect(appContext('all')).not.toBe(platform)
  })
})
