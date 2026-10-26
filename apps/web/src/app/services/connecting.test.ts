import { CONNECT_MARKER_ATTRIBUTE } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSources } from '../../features/search/sources'
import { CONNECT_GRACE_MS, MARKER_ATTRIBUTE, markConnecting } from './connecting'

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.removeAttribute(CONNECT_MARKER_ATTRIBUTE)
})

describe('markConnecting', () => {
  it("looks for FXM Connect's own marker", () => {
    expect(MARKER_ATTRIBUTE).toBe(CONNECT_MARKER_ATTRIBUTE)
  })

  it("does nothing without FXM Connect's marker", () => {
    const sources = createSources()

    markConnecting(sources)

    expect(sources.getSnapshot().detecting).toBe(false)
  })

  it('says the tier is being worked out while the marker is there, for the grace period', () => {
    vi.useFakeTimers()
    document.documentElement.setAttribute(CONNECT_MARKER_ATTRIBUTE, '0.1.0')
    const sources = createSources()

    markConnecting(sources)
    expect(sources.getSnapshot().detecting).toBe(true)

    // An FXM Connect that never answers is as good as none: the pages offer the install then.
    vi.advanceTimersByTime(CONNECT_GRACE_MS - 1)
    expect(sources.getSnapshot().detecting).toBe(true)
    vi.advanceTimersByTime(1)
    expect(sources.getSnapshot().detecting).toBe(false)
  })

  it('can end early', () => {
    vi.useFakeTimers()
    document.documentElement.setAttribute(CONNECT_MARKER_ATTRIBUTE, '0.1.0')
    const sources = createSources()
    const listener = vi.fn()

    const stop = markConnecting(sources)
    sources.subscribe(listener)
    stop()
    vi.runAllTimers()

    expect(sources.getSnapshot().detecting).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
  })
})
