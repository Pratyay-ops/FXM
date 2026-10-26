import { parseDistribution } from '@fxm/platform'
import { describe, expect, it, vi } from 'vitest'
import { distributionFlag, isDistributionFlag } from './distribution-flag'
import { appUpdateSupport, buildDistribution } from './support'

describe('appUpdateSupport', () => {
  it('checks in the Android app from GitHub Releases, for a released version', () => {
    expect(
      appUpdateSupport({ environment: 'capacitor', distribution: 'standard', version: '0.5.0' }),
    ).toEqual({ checks: true, version: '0.5.0' })
  })

  it('never in the web or desktop app, which update otherwise', () => {
    for (const environment of ['browser', 'tauri', 'node'] as const) {
      expect(appUpdateSupport({ environment, distribution: 'standard', version: '0.5.0' })).toEqual(
        { checks: false, reason: 'not-android' },
      )
    }
    // Vitest runs as a browser page.
    expect(appUpdateSupport()).toEqual({ checks: false, reason: 'not-android' })
  })

  it('never in F-Droid builds, which F-Droid updates', () => {
    expect(
      appUpdateSupport({ environment: 'capacitor', distribution: 'fdroid', version: '0.5.0' }),
    ).toEqual({ checks: false, reason: 'fdroid' })
  })

  it('never in a build of no released version', () => {
    for (const version of ['0.0.0', 'dev', '']) {
      expect(
        appUpdateSupport({ environment: 'capacitor', distribution: 'standard', version }),
      ).toEqual({ checks: false, reason: 'unreleased' })
    }
  })
})

describe('the FXM_DISTRIBUTION build flag', () => {
  it('is fdroid in F-Droid builds and standard otherwise', () => {
    expect(buildDistribution('fdroid')).toBe('fdroid')
    expect(buildDistribution('')).toBe('standard')
    expect(buildDistribution(undefined)).toBe('standard')
    vi.stubEnv('FXM_DISTRIBUTION', 'F-Droid')
    expect(buildDistribution()).toBe('fdroid')
    vi.unstubAllEnvs()
  })

  it('turns the check off for a value it doesn’t know', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(buildDistribution('fdorid')).toBe('fdroid')
    expect(error).toHaveBeenCalledOnce()
  })

  it('fails the build for that value first, accepting what parseDistribution accepts', () => {
    const accepts = (value: string) => {
      try {
        parseDistribution(value)
        return true
      } catch {
        return false
      }
    }
    const values = ['', ' ', 'standard', 'Standard', 'fdroid', ' FDroid ', 'f-droid', 'F-DROID']
    const typos = ['f_droid', 'fdorid', 'fdroid-build', 'github', 'true', '1', 'standard,fdroid']
    for (const value of [...values, ...typos]) {
      expect(isDistributionFlag(value), value).toBe(accepts(value))
    }
    expect(isDistributionFlag(undefined)).toBe(true)
    expect(distributionFlag(' fdroid ')).toBe('fdroid')
    expect(distributionFlag(undefined)).toBe('')
    expect(() => distributionFlag('fdorid')).toThrow(/FXM_DISTRIBUTION is "fdorid"/)
  })
})
