import { describe, expect, it, vi } from 'vitest'
import { createDesktopNetworkMonitor } from './network'

/** A shell whose native network notifications a test sends. */
function fakeShell() {
  let notify: (() => void) | undefined
  const stopped = vi.fn()
  return {
    shell: {
      onNetworkChange(listener: () => void) {
        notify = listener
        return () => {
          notify = undefined
          stopped()
        }
      },
    },
    stopped,
    change: () => notify?.(),
  }
}

describe('createDesktopNetworkMonitor', () => {
  it('starts on a network and never reports cellular data', () => {
    const monitor = createDesktopNetworkMonitor({ ...fakeShell(), target: new EventTarget() })
    expect(monitor.id).toBe('desktop-network-0')
    expect(monitor.cellular).toBe(false)
  })

  it('moves to a new network on a native change, online and offline', () => {
    const { shell, change } = fakeShell()
    const target = new EventTarget()
    const monitor = createDesktopNetworkMonitor({ shell, target })
    const listener = vi.fn()
    monitor.subscribe(listener)
    const ids = [monitor.id]
    change()
    ids.push(monitor.id)
    target.dispatchEvent(new Event('offline'))
    ids.push(monitor.id)
    target.dispatchEvent(new Event('online'))
    ids.push(monitor.id)
    expect(new Set(ids).size).toBe(4)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('ignores other events, such as the Network Information API’s estimates', () => {
    const target = new EventTarget()
    const monitor = createDesktopNetworkMonitor({ ...fakeShell(), target })
    target.dispatchEvent(new Event('change'))
    expect(monitor.id).toBe('desktop-network-0')
  })

  it('keeps notifying when a listener throws', () => {
    const { shell, change } = fakeShell()
    const monitor = createDesktopNetworkMonitor({ shell, target: new EventTarget() })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    monitor.subscribe(() => {
      throw new Error('broken listener')
    })
    monitor.subscribe(after)
    change()
    expect(after).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('stops listening when unsubscribed or destroyed', () => {
    const { shell, change, stopped } = fakeShell()
    const target = new EventTarget()
    const monitor = createDesktopNetworkMonitor({ shell, target })
    const listener = vi.fn()
    const unsubscribe = monitor.subscribe(listener)
    unsubscribe()
    change()
    expect(listener).not.toHaveBeenCalled()
    monitor.subscribe(listener)
    monitor.destroy()
    expect(stopped).toHaveBeenCalledOnce()
    target.dispatchEvent(new Event('online'))
    expect(listener).not.toHaveBeenCalled()
    expect(monitor.id).toBe('desktop-network-1')
  })
})
