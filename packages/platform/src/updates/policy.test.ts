import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { CODE_UPDATES_CONSENT, parseDistribution, updatePolicy } from './policy.ts'

describe('parseDistribution', () => {
  it('reads fdroid and standard in any case, and nothing as standard', () => {
    for (const value of ['fdroid', ' FDroid ', 'f-droid', 'F-Droid']) {
      expect(parseDistribution(value)).toBe('fdroid')
    }
    for (const value of [undefined, null, '', '  ', 'standard', 'Standard']) {
      expect(parseDistribution(value)).toBe('standard')
    }
  })

  it.each(['f_droid', 'F_DROID', 'fdroid-build', 'fdorid', 'github', 'true', 1])(
    'fails the build for %j instead of making a standard build',
    (value) => {
      let error: unknown
      try {
        parseDistribution(value)
      } catch (caught) {
        error = caught
      }
      expect(isFxmError(error, 'Unsupported')).toBe(true)
    },
  )
})

describe('updatePolicy', () => {
  it('lets standard builds update code and check for app updates', () => {
    expect(updatePolicy('standard')).toEqual({ appUpdateCheck: true, codeNeedsOptIn: false })
  })

  it('turns both off in F-Droid builds until the user opts in', () => {
    expect(updatePolicy('fdroid')).toEqual({ appUpdateCheck: false, codeNeedsOptIn: true })
  })
})

describe('CODE_UPDATES_CONSENT', () => {
  it('says plainly that turning it on bypasses F-Droid’s checks, as F-Droid requires', () => {
    const text = [CODE_UPDATES_CONSENT.title, ...CODE_UPDATES_CONSENT.body].join(' ')
    expect(text).toMatch(/bypass F-Droid’s checks/)
    expect(text).toMatch(/download/i)
    expect(CODE_UPDATES_CONSENT.setting).toMatch(/bypasses F-Droid’s checks/)
  })

  it('offers declining as plainly as accepting', () => {
    expect(CODE_UPDATES_CONSENT.accept).toBe('Turn on')
    expect(CODE_UPDATES_CONSENT.decline).toBe('Not now')
  })
})
