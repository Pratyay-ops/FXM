import { describe, expect, it } from 'vitest'
import { BUILD_DISTRIBUTION, distributionOf } from './distribution'

describe('the build’s distribution', () => {
  it('is standard without flags, and F-Droid when either flag names it', () => {
    expect(distributionOf(undefined, undefined)).toBe('standard')
    expect(distributionOf('', 'standard')).toBe('standard')
    expect(distributionOf('fdroid', undefined)).toBe('fdroid')
    expect(distributionOf(undefined, 'F-Droid')).toBe('fdroid')
    expect(distributionOf('standard', 'fdroid')).toBe('fdroid')
  })

  it('takes a flag it doesn’t know for F-Droid, which asks first', () => {
    expect(distributionOf('fdorid', undefined)).toBe('fdroid')
    expect(distributionOf(undefined, 'github')).toBe('fdroid')
  })

  it('is standard in the test build, which sets neither flag', () => {
    expect(BUILD_DISTRIBUTION).toBe('standard')
  })
})
