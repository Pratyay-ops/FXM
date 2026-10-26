import { describe, expect, it } from 'vitest'
import { isDevVariant, outputNames, stagingFolder } from './variant.ts'

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
      folder: 'dev/firefox',
      zip: 'dev/fxm-connect-firefox-0.1.0-dev.zip',
    })
  })

  it('keeps development builds out of dist/*.zip, where releases pick up their zips', () => {
    for (const browser of ['chromium', 'firefox'] as const) {
      const dev = outputNames(browser, '0.1.0', true)
      expect(dev.zip.startsWith('dev/')).toBe(true)
      expect(dev.folder.startsWith('dev/')).toBe(true)
      expect(outputNames(browser, '0.1.0', false).zip).not.toContain('/')
    }
    expect(stagingFolder(true).startsWith('dev/')).toBe(true)
    expect(stagingFolder(false)).not.toBe(stagingFolder(true))
  })
})
