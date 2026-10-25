import { afterEach, describe, expect, it, vi } from 'vitest'
import { callSafely, Emitter } from './emitter'

interface Events {
  count: number
  done: undefined
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Emitter', () => {
  it('calls the listeners of a type in the order they were added', () => {
    const emitter = new Emitter<Events>()
    const calls: string[] = []
    emitter.on('count', (n) => calls.push(`first ${n}`))
    emitter.on('count', (n) => calls.push(`second ${n}`))
    emitter.on('done', () => calls.push('done'))
    emitter.emit('count', 3)
    emitter.emit('done', undefined)
    expect(calls).toEqual(['first 3', 'second 3', 'done'])
  })

  it('removes a listener, and ignores types without listeners', () => {
    const emitter = new Emitter<Events>()
    const listener = vi.fn()
    const off = emitter.on('count', listener)
    off()
    off()
    emitter.emit('count', 1)
    emitter.emit('done', undefined)
    expect(listener).not.toHaveBeenCalled()
  })

  it('lets a listener remove itself while the others still run', () => {
    const emitter = new Emitter<Events>()
    const later = vi.fn()
    const off = emitter.on('count', () => off())
    emitter.on('count', later)
    emitter.emit('count', 1)
    emitter.emit('count', 2)
    expect(later).toHaveBeenCalledTimes(2)
  })

  it('reports a throwing listener and still calls the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const emitter = new Emitter<Events>()
    const after = vi.fn()
    emitter.on('count', () => {
      throw new Error('listener bug')
    })
    emitter.on('count', after)
    expect(() => emitter.emit('count', 1)).not.toThrow()
    expect(after).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledWith(new Error('listener bug'))
  })

  it('drops every listener on clear', () => {
    const emitter = new Emitter<Events>()
    const listener = vi.fn()
    emitter.on('count', listener)
    emitter.clear()
    emitter.emit('count', 1)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('callSafely', () => {
  it('passes the arguments through', () => {
    const listener = vi.fn()
    callSafely(listener, 1, 'two')
    expect(listener).toHaveBeenCalledWith(1, 'two')
  })
})
