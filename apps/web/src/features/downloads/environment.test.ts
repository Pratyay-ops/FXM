import { formatId, type ProviderContext, type Track } from '@fxm/core'
import { createPolicyDownloadResolver } from '@fxm/downloads'
import { describe, expect, it, vi } from 'vitest'
import {
  connectDownloadEnvironment,
  createAppDownloadEnvironment,
  type DownloadEnvironment,
} from './environment'

const ARCHIVE: Track = {
  id: formatId('archive', 'track', 'item/01.flac'),
  source: 'archive',
  title: 'One',
  artists: [{ name: 'Someone' }],
  artwork: [],
  kind: 'song',
}

/** An environment on a given platform context, which says when it changes. */
function environmentOn(capabilities: ProviderContext['capabilities']) {
  const listeners = new Set<() => void>()
  const resolve = vi.fn()
  const environment: DownloadEnvironment = {
    context: () =>
      ({ fetch: vi.fn(), platform: 'web', capabilities, mode: 'music' }) as ProviderContext,
    resolver: { resolve, canResolve: () => true },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const changed = () => {
    for (const listener of listeners) listener()
  }
  return { environment, resolve, changed }
}

describe("the app's download environment", () => {
  it('stands in with the free tier and no sources until the composition root connects its own', () => {
    const app = createAppDownloadEnvironment()

    expect(app.context().capabilities.youtube).toBe('none')
    // Nothing is offered rather than offered and then failed.
    expect(app.resolver.canResolve?.(ARCHIVE)).toBe(false)
  })

  it('follows the connected environment, and tells its listeners when it changes', () => {
    const app = createAppDownloadEnvironment()
    const listener = vi.fn()
    const stop = app.subscribe(listener)
    const full = environmentOn({
      youtube: 'full',
      spotify: 'anonymous',
      mediaBytes: true,
      fileSystem: false,
    })

    const disconnect = connectDownloadEnvironment(full.environment)

    expect(listener).toHaveBeenCalledOnce()
    expect(app.context().capabilities.mediaBytes).toBe(true)
    expect(app.resolver.canResolve?.(ARCHIVE)).toBe(true)
    full.changed()
    expect(listener).toHaveBeenCalledTimes(2)

    disconnect()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(app.context().capabilities.youtube).toBe('none')
    stop()
  })

  it('leaves an environment connected after it alone when disconnected', () => {
    const app = createAppDownloadEnvironment()
    const capabilities = {
      youtube: 'full',
      spotify: 'anonymous',
      mediaBytes: true,
      fileSystem: false,
    } as const
    const first = connectDownloadEnvironment(environmentOn(capabilities).environment)
    const second = environmentOn(capabilities)
    const stopSecond = connectDownloadEnvironment(second.environment)

    first()

    expect(app.context().capabilities.mediaBytes).toBe(true)
    stopSecond()
    // The stand-in's resolver has no sources at all.
    expect(createPolicyDownloadResolver({ sources: [] }).canResolve?.(ARCHIVE)).toBe(false)
  })
})
