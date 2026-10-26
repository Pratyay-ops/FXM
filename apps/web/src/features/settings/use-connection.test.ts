import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeConnection, installConnection, removeConnection } from './fake-connection'
import { readConnection, useConnection } from './use-connection'

afterEach(removeConnection)

describe('readConnection', () => {
  it('reports no support where the browser has no connection type', () => {
    expect(readConnection(undefined)).toEqual({ supported: false, detected: 'unknown' })
    // Desktop Chromium has navigator.connection, without a type.
    expect(readConnection(new FakeConnection())).toEqual({ supported: false, detected: 'unknown' })
    expect(readConnection(new FakeConnection(4))).toEqual({ supported: false, detected: 'unknown' })
  })

  it('reads the connection type where the browser reports one', () => {
    expect(readConnection(new FakeConnection('wifi'))).toEqual({
      supported: true,
      detected: 'wifi',
    })
    expect(readConnection(new FakeConnection('ethernet'))).toMatchObject({ detected: 'wifi' })
    expect(readConnection(new FakeConnection('cellular'))).toMatchObject({ detected: 'cellular' })
    expect(readConnection(new FakeConnection('bluetooth'))).toEqual({
      supported: true,
      detected: 'unknown',
    })
  })

  it('answers with the same object until the connection changes', () => {
    const connection = new FakeConnection('wifi')
    const first = readConnection(connection)
    expect(readConnection(connection)).toBe(first)
    connection.change('cellular')
    expect(readConnection(connection)).not.toBe(first)
  })

  it('reads navigator.connection by default', () => {
    expect(readConnection()).toEqual({ supported: false, detected: 'unknown' })
    installConnection(new FakeConnection('cellular'))
    expect(readConnection()).toEqual({ supported: true, detected: 'cellular' })
  })
})

describe('useConnection', () => {
  it('follows the connection as it changes', () => {
    const connection = new FakeConnection('wifi')
    installConnection(connection)
    const { result, unmount } = renderHook(() => useConnection())
    expect(result.current).toEqual({ supported: true, detected: 'wifi' })

    act(() => connection.change('cellular'))
    expect(result.current).toEqual({ supported: true, detected: 'cellular' })

    unmount()
    expect(() => connection.change('wifi')).not.toThrow()
  })

  it('reports no support without the API', () => {
    const { result } = renderHook(() => useConnection())
    expect(result.current).toEqual({ supported: false, detected: 'unknown' })
  })
})
