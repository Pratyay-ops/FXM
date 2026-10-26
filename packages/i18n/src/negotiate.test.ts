import { describe, expect, it, vi } from 'vitest'
import {
  applyDocumentLocale,
  fallbackChain,
  negotiateLocale,
  requestedLocales,
  textDirection,
} from './negotiate'

const available = ['en', 'de', 'fr', 'pt', 'pt-BR', 'zh-Hans', 'zh-Hant', 'sr-Latn', 'ar']
const negotiate = (requested: string[], preference?: string, list = available) =>
  negotiateLocale({ available: list, defaultLocale: 'en', requested, preference })

describe('negotiateLocale', () => {
  it('takes the first of the browser’s languages it has', () => {
    expect(negotiate(['ja', 'de-AT', 'fr']).locale).toBe('de')
    expect(negotiate(['fr-CA', 'de']).locale).toBe('fr')
  })

  it('falls back to the default locale', () => {
    expect(negotiate(['ja', 'ko'])).toEqual({ locale: 'en', formatLocale: 'en', direction: 'ltr' })
    expect(negotiate([])).toEqual({ locale: 'en', formatLocale: 'en', direction: 'ltr' })
  })

  it('formats in the user’s own tag when it is the same language', () => {
    expect(negotiate(['en-IN'])).toEqual({ locale: 'en', formatLocale: 'en-IN', direction: 'ltr' })
    expect(negotiate(['de-CH']).formatLocale).toBe('de-CH')
  })

  it('respects scripts', () => {
    expect(negotiate(['zh-TW']).locale).toBe('zh-Hant')
    expect(negotiate(['zh-HK']).locale).toBe('zh-Hant')
    expect(negotiate(['zh-CN']).locale).toBe('zh-Hans')
    expect(negotiate(['zh']).locale).toBe('zh-Hans')
    expect(negotiate(['sr-Latn-RS']).locale).toBe('sr-Latn')
    // Serbian in Cyrillic, the default script, has no catalog here.
    expect(negotiate(['sr']).locale).toBe('en')
  })

  it('picks between regional catalogs of one language by region', () => {
    expect(negotiate(['pt-BR']).locale).toBe('pt-BR')
    expect(negotiate(['pt-PT']).locale).toBe('pt')
    expect(negotiate(['pt-PT'], undefined, ['en', 'pt-BR']).locale).toBe('pt-BR')
    expect(negotiate(['en-GB'], undefined, ['en', 'en-AU']).locale).toBe('en')
    expect(negotiate(['en-AU'], undefined, ['en', 'en-AU']).locale).toBe('en-AU')
  })

  it('gives a bare language its likely region, whatever the order of the catalogs', () => {
    const both = (requested: string, list: string[]) => [
      negotiate([requested], undefined, list).locale,
      negotiate([requested], undefined, [...list].reverse()).locale,
    ]
    expect(both('pt', ['en', 'pt-PT', 'pt-BR'])).toEqual(['pt-BR', 'pt-BR'])
    expect(both('es', ['en', 'es-419', 'es-ES'])).toEqual(['es-ES', 'es-ES'])
    expect(both('pt-PT', ['en', 'pt', 'pt-BR'])).toEqual(['pt', 'pt'])
    // Without a catalog for its region or the language, the language's main variety.
    expect(both('es-AR', ['en', 'es-MX', 'es-ES'])).toEqual(['es-ES', 'es-ES'])
    expect(both('pt-AO', ['en', 'pt-PT', 'pt-BR'])).toEqual(['pt-BR', 'pt-BR'])
  })

  it('honours the Settings choice, keeping the user’s region for formats', () => {
    expect(negotiate(['en-US', 'de-AT'], 'de')).toEqual({
      locale: 'de',
      formatLocale: 'de-AT',
      direction: 'ltr',
    })
    expect(negotiate(['en-US'], 'fr')).toEqual({
      locale: 'fr',
      formatLocale: 'fr',
      direction: 'ltr',
    })
  })

  it('ignores a Settings choice it has no catalog for, and invalid tags', () => {
    expect(negotiate(['de'], 'ja').locale).toBe('de')
    expect(negotiate(['not a tag', 'fr'], 'nope!').locale).toBe('fr')
  })

  it('gives pseudo-locales only to those who choose them', () => {
    const list = ['en', 'en-XA', 'ar-XB']
    expect(negotiate(['en-GB'], undefined, list).locale).toBe('en')
    expect(negotiate(['en-US'], undefined, list).locale).toBe('en')
    expect(negotiate(['en-US'], 'en-XA', list)).toEqual({
      locale: 'en-XA',
      formatLocale: 'en-US',
      direction: 'ltr',
    })
    expect(negotiate(['en-US'], 'ar-XB', list)).toEqual({
      locale: 'ar-XB',
      formatLocale: 'ar-XB',
      direction: 'rtl',
    })
  })

  it('canonicalizes tags', () => {
    expect(negotiate(['PT-br']).locale).toBe('pt-BR')
    expect(negotiate(['EN-in']).formatLocale).toBe('en-IN')
  })

  it('chooses one of the available locales as the app spells it', () => {
    const list = ['en', 'pt-br', 'zh-hant']
    expect(negotiate(['pt-BR'], undefined, list).locale).toBe('pt-br')
    expect(negotiate(['zh-TW'], undefined, list)).toEqual({
      locale: 'zh-hant',
      formatLocale: 'zh-TW',
      direction: 'ltr',
    })
    expect(negotiate(['en-US'], 'PT-BR', list).locale).toBe('pt-br')
  })

  it('says which way the chosen locale is written', () => {
    expect(negotiate(['ar-EG']).direction).toBe('rtl')
  })
})

describe('textDirection', () => {
  it('reads the direction from the script, filling in likely subtags', () => {
    expect(
      ['ar', 'he', 'fa', 'ur', 'ckb', 'yi', 'dv', 'ar-XB', 'pa-Arab'].map(textDirection),
    ).toEqual(Array(9).fill('rtl'))
    expect(
      ['en', 'de', 'zh-Hant', 'ja', 'pa', 'ku', 'az-Latn', 'en-XA'].map(textDirection),
    ).toEqual(Array(8).fill('ltr'))
    expect(textDirection('not a tag')).toBe('ltr')
  })
})

describe('requestedLocales', () => {
  it('reads navigator.languages, else navigator.language', () => {
    expect(requestedLocales({ languages: ['de-AT', 'en'], language: 'de-AT' })).toEqual([
      'de-AT',
      'en',
    ])
    expect(requestedLocales({ languages: [], language: 'fr' })).toEqual(['fr'])
    expect(requestedLocales({})).toEqual([])
  })

  it('reads the global navigator by default', () => {
    vi.stubGlobal('navigator', { languages: ['ar-EG', 'en-GB'], language: 'ar-EG' })
    try {
      expect(requestedLocales()).toEqual(['ar-EG', 'en-GB'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('fallbackChain', () => {
  it('drops subtags while the script stays the same', () => {
    expect(fallbackChain('pt-BR')).toEqual(['pt-BR', 'pt'])
    expect(fallbackChain('de')).toEqual(['de'])
    expect(fallbackChain('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh-Hant'])
    expect(fallbackChain('sr-Latn-RS')).toEqual(['sr-Latn-RS', 'sr-Latn'])
    expect(fallbackChain('nope!')).toEqual(['nope!'])
  })
})

describe('applyDocumentLocale', () => {
  it('sets lang and dir', () => {
    const attributes = new Map<string, string>()
    applyDocumentLocale(
      { locale: 'ar', direction: 'rtl' },
      { setAttribute: (name, value) => attributes.set(name, value) },
    )
    expect(Object.fromEntries(attributes)).toEqual({ lang: 'ar', dir: 'rtl' })
  })

  it('does nothing without a document', () => {
    expect(() => applyDocumentLocale({ locale: 'en', direction: 'ltr' })).not.toThrow()
  })
})
