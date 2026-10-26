import { CODE_UPDATES_CONSENT, parseDistribution } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import { PLUGINS_CONSENT, pluginPolicy } from './consent'

describe('the plugin policy', () => {
  it('needs an opt-in only in F-Droid builds', () => {
    expect(pluginPolicy(parseDistribution('fdroid'))).toEqual({ needsOptIn: true })
    expect(pluginPolicy(parseDistribution(undefined))).toEqual({ needsOptIn: false })
  })

  it('says plainly that turning plugins on bypasses F-Droid’s checks, as F-Droid requires', () => {
    const text = [PLUGINS_CONSENT.title, ...PLUGINS_CONSENT.body].join(' ')
    expect(text).toMatch(/bypass F-Droid’s checks/u)
    expect(text).toMatch(/don’t come from F-Droid/u)
    expect(PLUGINS_CONSENT.setting).toMatch(/bypasses F-Droid’s checks/u)
    // Two equal choices, worded like the signed-updates opt-in of stage 1.13.
    expect(PLUGINS_CONSENT.accept).toBe(CODE_UPDATES_CONSENT.accept)
    expect(PLUGINS_CONSENT.decline).toBe(CODE_UPDATES_CONSENT.decline)
  })
})
