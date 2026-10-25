import { describe, expect, it } from 'vitest'
import { CODE_UPDATES_CONSENT, parseDistribution, updatePolicy } from './policy.ts'

describe('parseDistribution', () => {
  it('reads fdroid, and makes anything else a standard build', () => {
    expect(parseDistribution('fdroid')).toBe('fdroid')
    expect(parseDistribution(' FDroid ')).toBe('fdroid')
    for (const value of [undefined, '', 'standard', 'github', 1]) {
      expect(parseDistribution(value)).toBe('standard')
    }
  })
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
