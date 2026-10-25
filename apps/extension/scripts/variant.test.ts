import { describe, expect, it } from 'vitest'
import { isDevVariant, outputNames } from './variant.ts'

describe('build variants', () => {
  it('reads FXM_EXTENSION_DEV', () => {
    for (const value of ['1', 'true', 'YES', ' 1 ']) expect(isDevVariant(value)).toBe(true)
    for (const value of [undefined, '', '0', 'false', 'no']) expect(isDevVariant(value)).toBe(false)
    expect(() => isDevVariant('maybe')).toThrow(/FXM_EXTENSION_DEV/)
  })

  it('names the unpacked folders and zips', () => {
    expect(outputNames('chromium', '0.1.0', false)).toEqual({
      folder: 'chromium',
      zip: 'fxm-connect-chromium-0.1.0.zip',
    })
    expect(outputNames('firefox', '0.1.0', true)).toEqual({
      folder: 'firefox-dev',
      zip: 'fxm-connect-firefox-0.1.0-dev.zip',
    })
  })
})
