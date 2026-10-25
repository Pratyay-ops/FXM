import { afterEach, describe, expect, it } from 'vitest'
import { eitherSignal } from './signals'

const nativeAny = AbortSignal.any

describe.each([
  ['with AbortSignal.any', false],
  ['without AbortSignal.any (older webviews)', true],
])('eitherSignal %s', (_name, withoutAny) => {
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', {
      value: nativeAny,
      configurable: true,
      writable: true,
    })
  })

  function setup() {
    if (withoutAny) {
      Object.defineProperty(AbortSignal, 'any', {
        value: undefined,
        configurable: true,
        writable: true,
      })
    }
    return { first: new AbortController(), second: new AbortController() }
  }

  it('returns the second signal alone when there is no first one', () => {
    const { second } = setup()
    expect(eitherSignal(undefined, second.signal)).toBe(second.signal)
  })

  it('aborts with the reason of whichever aborts first', () => {
    const { first, second } = setup()
    const combined = eitherSignal(first.signal, second.signal)
    expect(combined.aborted).toBe(false)
    second.abort('timeout')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('timeout')
    first.abort('caller')
    expect(combined.reason).toBe('timeout')
  })

  it('is aborted at once when an input already is', () => {
    const { first, second } = setup()
    first.abort('early')
    const combined = eitherSignal(first.signal, second.signal)
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('early')
  })
})
