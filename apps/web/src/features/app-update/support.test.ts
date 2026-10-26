import { parseDistribution } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { distributionFlag, isDistributionFlag } from './distribution-flag'
import { appUpdateSupport, buildDistribution, isGitHubReleasesBuild } from './support'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('appUpdateSupport', () => {
  it('checks in the Android app from GitHub Releases, for a released version', () => {
    for (const distributionFlag of ['standard', ' Standard ']) {
      expect(
        appUpdateSupport({ environment: 'capacitor', distributionFlag, version: '0.5.0' }),
      ).toEqual({ checks: true, version: '0.5.0' })
    }
  })

  it('never in the web or desktop app, which update otherwise', () => {
    for (const environment of ['browser', 'tauri', 'node'] as const) {
      expect(
        appUpdateSupport({ environment, distributionFlag: 'standard', version: '0.5.0' }),
      ).toEqual({ checks: false, reason: 'not-android' })
    }
    // Vitest runs as a browser page.
    expect(appUpdateSupport()).toEqual({ checks: false, reason: 'not-android' })
  })

  it('never in F-Droid builds, which F-Droid updates', () => {
    for (const distributionFlag of ['fdroid', 'F-Droid']) {
      expect(
        appUpdateSupport({ environment: 'capacitor', distributionFlag, version: '0.5.0' }),
      ).toEqual({ checks: false, reason: 'fdroid' })
    }
  })

  it('never in a build that doesn’t say it is the one from GitHub Releases', () => {
    // A development build, `make apk` at a release tag, or someone else's rebuild: signed with
    // another key, so the APK it would offer couldn't install over it.
    for (const distributionFlag of ['', ' ']) {
      expect(
        appUpdateSupport({ environment: 'capacitor', distributionFlag, version: '0.5.0' }),
      ).toEqual({ checks: false, reason: 'unofficial-build' })
    }
    // This build's flag, as vite.config.ts builds it in: unset in tests.
    expect(appUpdateSupport({ environment: 'capacitor', version: '0.5.0' })).toEqual({
      checks: false,
      reason: 'unofficial-build',
    })
    vi.stubEnv('FXM_DISTRIBUTION', 'standard')
    expect(appUpdateSupport({ environment: 'capacitor', version: '0.5.0' })).toEqual({
      checks: true,
      version: '0.5.0',
    })
  })

  it('never in a build of no released version', () => {
    for (const version of ['0.0.0', 'dev', '']) {
      expect(
        appUpdateSupport({ environment: 'capacitor', distributionFlag: 'standard', version }),
      ).toEqual({ checks: false, reason: 'unreleased' })
    }
  })
})

describe('the FXM_DISTRIBUTION build flag', () => {
  it('is fdroid in F-Droid builds and standard otherwise, for the platform’s update policy', () => {
    expect(buildDistribution('fdroid')).toBe('fdroid')
    expect(buildDistribution('')).toBe('standard')
    expect(buildDistribution(undefined)).toBe('standard')
    vi.stubEnv('FXM_DISTRIBUTION', 'F-Droid')
    expect(buildDistribution()).toBe('fdroid')
  })

  it('names the build from GitHub Releases only when it says standard', () => {
    expect(isGitHubReleasesBuild('standard')).toBe(true)
    expect(isGitHubReleasesBuild(' STANDARD ')).toBe(true)
    for (const flag of ['', ' ', undefined, 'fdroid', 'f-droid', 'standard,fdroid', 1]) {
      expect(isGitHubReleasesBuild(flag), String(flag)).toBe(false)
    }
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
