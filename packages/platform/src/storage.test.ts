import { describe, expect, it, vi } from 'vitest'
import { systemClock } from './clock'
import {
  browserStorage,
  type KeyValueStorage,
  memoryStorage,
  readJson,
  removeKey,
  writeJson,
} from './storage'

const throwing: KeyValueStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  },
}

describe('memoryStorage', () => {
  it('stores, reads and removes strings, starting from what it is given', () => {
    const storage = memoryStorage({ a: '1' })
    expect(storage.getItem('a')).toBe('1')
    storage.setItem('b', '2')
    expect(storage.getItem('b')).toBe('2')
    storage.removeItem('a')
    expect(storage.getItem('a')).toBeNull()
  })
})

describe('browserStorage', () => {
  it('returns localStorage when there is one', () => {
    const localStorage = memoryStorage()
    expect(browserStorage({ localStorage })).toBe(localStorage)
  })

  it('returns undefined when there is none or reading it throws', () => {
    expect(browserStorage({})).toBeUndefined()
    expect(browserStorage(undefined)).toBeUndefined()
    expect(browserStorage({ localStorage: null } as never)).toBeUndefined()
    const guarded = {
      get localStorage(): KeyValueStorage {
        throw new Error('SecurityError')
      },
    }
    expect(browserStorage(guarded)).toBeUndefined()
  })

  it('looks at the global object by default', () => {
    expect(browserStorage()).toBe(
      (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? undefined,
    )
  })
})

describe('JSON helpers', () => {
  it('read and write JSON values', () => {
    const storage = memoryStorage()
    expect(writeJson(storage, 'k', { a: [1] })).toBe(true)
    expect(readJson(storage, 'k')).toEqual({ a: [1] })
    removeKey(storage, 'k')
    expect(readJson(storage, 'k')).toBeUndefined()
  })

  it('never throw, whatever the storage does', () => {
    expect(readJson(memoryStorage({ k: '{bad' }), 'k')).toBeUndefined()
    expect(readJson(throwing, 'k')).toBeUndefined()
    expect(writeJson(throwing, 'k', 1)).toBe(false)
    expect(() => removeKey(throwing, 'k')).not.toThrow()
  })
})

describe('systemClock', () => {
  it('uses the global timers at call time', () => {
    vi.useFakeTimers({ now: 1234 })
    try {
      expect(systemClock.now()).toBe(1234)
      const callback = vi.fn()
      const handle = systemClock.setTimeout(callback, 10)
      systemClock.clearTimeout(handle)
      systemClock.setTimeout(callback, 20)
      vi.advanceTimersByTime(20)
      expect(callback).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
