import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ConnectionLike,
  createBrowserNetworkMonitor,
  createStaticNetworkMonitor,
} from './network'

/** A Network Information API stand-in whose `type` a test sets. */
function connection(type?: string): ConnectionLike & { type?: string } {
  const target = new EventTarget() as EventTarget & { type?: string }
  if (type !== undefined) target.type = type
  return target
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createBrowserNetworkMonitor', () => {
  it('moves to a new network on online, offline and a change of connection type', () => {
    const target = new EventTarget()
    const link = connection('wifi')
    const monitor = createBrowserNetworkMonitor({ target, connection: link })
    const changes: string[] = []
    monitor.subscribe(() => changes.push(monitor.id))
    const first = monitor.id
    target.dispatchEvent(new Event('offline'))
    target.dispatchEvent(new Event('online'))
    link.type = 'cellular'
    link.dispatchEvent(new Event('change'))
    expect(changes).toHaveLength(3)
    expect(new Set([first, ...changes]).size).toBe(4)
  })

  it('stays on the network when a change only moves the estimates', () => {
    const target = new EventTarget()
    const link = connection('wifi')
    const monitor = createBrowserNetworkMonitor({ target, connection: link })
    const changes: string[] = []
    monitor.subscribe(() => changes.push(monitor.id))
    const first = monitor.id
    link.dispatchEvent(new Event('change'))
    // Desktop Chromium has no type at all: only online and offline count there.
    const untyped = connection()
    const desktop = createBrowserNetworkMonitor({ target: new EventTarget(), connection: untyped })
    const before = desktop.id
    untyped.dispatchEvent(new Event('change'))
    expect(changes).toEqual([])
    expect(monitor.id).toBe(first)
    expect(desktop.id).toBe(before)
  })

  it('compares a later change with the type seen at the last change, online included', () => {
    const target = new EventTarget()
    const link = connection('wifi')
    const monitor = createBrowserNetworkMonitor({ target, connection: link })
    const changes: string[] = []
    monitor.subscribe(() => changes.push(monitor.id))
    link.type = 'cellular'
    target.dispatchEvent(new Event('online'))
    link.dispatchEvent(new Event('change'))
    expect(changes).toHaveLength(1)
  })

  it('knows mobile data from the connection type', () => {
    const link = connection('cellular')
    expect(
      createBrowserNetworkMonitor({ target: new EventTarget(), connection: link }).cellular,
    ).toBe(true)
    const wifi = createBrowserNetworkMonitor({
      target: new EventTarget(),
      connection: connection(),
    })
    expect(wifi.cellular).toBe(false)
    const none = createBrowserNetworkMonitor({ target: new EventTarget(), connection: null })
    expect(none.cellular).toBe(false)
  })

  it('stops a listener on request, and everything on destroy', () => {
    const target = new EventTarget()
    const monitor = createBrowserNetworkMonitor({ target, connection: null })
    const seen: string[] = []
    const stop = monitor.subscribe(() => seen.push('a'))
    monitor.subscribe(() => seen.push('b'))
    stop()
    target.dispatchEvent(new Event('online'))
    expect(seen).toEqual(['b'])
    monitor.destroy()
    target.dispatchEvent(new Event('online'))
    expect(seen).toEqual(['b'])
  })

  it('reports a listener that throws and still tells the others', () => {
    const target = new EventTarget()
    const monitor = createBrowserNetworkMonitor({ target, connection: null })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    monitor.subscribe(() => {
      throw new Error('boom')
    })
    monitor.subscribe(() => seen.push('ok'))
    target.dispatchEvent(new Event('offline'))
    expect(seen).toEqual(['ok'])
    expect(report).toHaveBeenCalledOnce()
  })

  it('listens to the window and navigator.connection by default', () => {
    const link = connection('cellular')
    Object.defineProperty(navigator, 'connection', { value: link, configurable: true })
    try {
      const monitor = createBrowserNetworkMonitor()
      const before = monitor.id
      window.dispatchEvent(new Event('online'))
      expect(monitor.id).not.toBe(before)
      expect(monitor.cellular).toBe(true)
      monitor.destroy()
    } finally {
      Reflect.deleteProperty(navigator, 'connection')
    }
  })
})

describe('createStaticNetworkMonitor', () => {
  it('never changes', () => {
    const monitor = createStaticNetworkMonitor(true)
    const stop = monitor.subscribe(() => {
      throw new Error('never called')
    })
    stop()
    expect(monitor).toMatchObject({ id: 'network-0', cellular: true })
    expect(createStaticNetworkMonitor().cellular).toBe(false)
  })
})
