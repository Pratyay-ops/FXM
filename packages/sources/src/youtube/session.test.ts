import { describe, expect, it } from 'vitest'
import { context, FULL, NONE, SIMPLE } from './fixtures/testing'
import { assertYouTubeReachable, innerTubeLanguage, innerTubeRegion, localeOf } from './session'

describe('the language and region of a call', () => {
  it.each([
    ['en', 'en'],
    ['en-in', 'en-IN'],
    ['pt_BR', 'pt-BR'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hant-HK', 'zh-HK'],
    ['sr-Latn', 'sr-Latn'],
    ['es-419', 'es'],
    ['de-DE-u-co-phonebk', 'de-DE'],
    [' fr-CA ', 'fr-CA'],
    ['', 'en'],
    ['123', 'en'],
    [undefined, 'en'],
  ])('hl for %s is %s', (locale, hl) => {
    expect(innerTubeLanguage(locale)).toBe(hl)
  })

  it('gl is the region in upper case, or nothing', () => {
    expect(innerTubeRegion('in')).toBe('IN')
    expect(innerTubeRegion(' GB ')).toBe('GB')
    expect(innerTubeRegion('USA')).toBeUndefined()
    expect(innerTubeRegion(undefined)).toBeUndefined()
    const fetch = globalThis.fetch
    expect(localeOf(context(fetch, { locale: 'en-GB', region: 'gb' }))).toEqual({
      hl: 'en-GB',
      gl: 'GB',
    })
    expect(localeOf({ ...context(fetch), region: 'Earth' })).toEqual({ hl: 'en' })
  })
})

describe('reachability', () => {
  it('fails fast without any YouTube access, and passes in the simple and full tiers', () => {
    const fetch = globalThis.fetch
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: NONE }))).toThrow(
      expect.objectContaining({ code: 'Unsupported' }),
    )
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: SIMPLE }))).not.toThrow()
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: FULL }))).not.toThrow()
  })
})
