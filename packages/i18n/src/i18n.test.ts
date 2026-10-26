import { describe, expect, it, vi } from 'vitest'
import { type Catalog, createI18n, type I18nOptions } from './i18n'
import { defineMessages } from './messages'
import type { MessageNode } from './parse'

const library = defineMessages('library', {
  title: 'Library',
  songs: '{count, plural, one {# song} other {# songs}}',
  liked: 'Liked songs',
})

const catalogs: Record<string, Catalog> = {
  de: { library: { title: 'Bibliothek', songs: '{count, plural, one {# Titel} other {# Titel}}' } },
  pt: { library: { title: 'Biblioteca', liked: 'Músicas curtidas' } },
  'pt-BR': { library: { title: 'Minha biblioteca' } },
  fr: { library: { title: 'Bibliothèque {', liked: 'Titres likés' } },
}

function setup(options: Partial<I18nOptions> = {}) {
  const load = vi.fn(async (locale: string) => {
    const catalog = catalogs[locale]
    if (catalog === undefined) throw new Error(`no catalog for ${locale}`)
    return catalog
  })
  const onMissing = vi.fn()
  const onError = vi.fn()
  const i18n = createI18n({
    locales: ['de', 'pt', 'pt-BR', 'fr', 'ja'],
    load,
    onMissing,
    onError,
    ...options,
  })
  return { i18n, load, onMissing, onError, t: i18n.translator(library) }
}

describe('createI18n', () => {
  it('speaks the source locale until told otherwise', () => {
    const { i18n, t, load } = setup()
    expect(i18n.locale).toBe('en')
    expect(i18n.formatLocale).toBe('en')
    expect(i18n.direction).toBe('ltr')
    expect(i18n.locales).toEqual(['en', 'de', 'pt', 'pt-BR', 'fr', 'ja'])
    expect(t('title')).toBe('Library')
    expect(t('songs', { count: 1 })).toBe('1 song')
    expect(load).not.toHaveBeenCalled()
  })

  it('loads a catalog once, then switches, and the same translators follow', async () => {
    const { i18n, t, load } = setup()
    const listener = vi.fn()
    i18n.subscribe(listener)
    const before = i18n.revision
    await i18n.setLocale('de', 'de-AT')
    expect(load).toHaveBeenCalledExactlyOnceWith('de')
    expect(i18n.locale).toBe('de')
    expect(i18n.formatLocale).toBe('de-AT')
    expect(i18n.revision).toBeGreaterThan(before)
    expect(listener).toHaveBeenCalled()
    expect(t('title')).toBe('Bibliothek')
    // Austria groups digits with a no-break space: numbers follow the format locale.
    expect(t('songs', { count: 1234 })).toBe('1\u00a0234 Titel')
    await i18n.setLocale('en')
    await i18n.setLocale('de')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('falls back along the chain, then to English, and reports the gap once', async () => {
    const { i18n, t, load, onMissing } = setup()
    await i18n.setLocale('pt-BR')
    expect(load.mock.calls).toEqual([['pt-BR'], ['pt']])
    expect(t('title')).toBe('Minha biblioteca')
    expect(t('liked')).toBe('Músicas curtidas')
    expect(t('songs', { count: 2 })).toBe('2 songs')
    expect(t('songs', { count: 3 })).toBe('3 songs')
    expect(onMissing).toHaveBeenCalledExactlyOnceWith({
      locale: 'pt-BR',
      namespace: 'library',
      key: 'songs',
    })
  })

  it('passes over empty messages, as translation platforms write untranslated ones', async () => {
    const onMissing = vi.fn()
    const i18n = createI18n({
      locales: ['pt', 'pt-BR'],
      load: async (locale) =>
        locale === 'pt'
          ? { library: { title: 'Biblioteca', songs: '' } }
          : { library: { title: '', songs: '', liked: '' } },
      onMissing,
    })
    await i18n.setLocale('pt-BR')
    const t = i18n.translator(library)
    expect(t('title')).toBe('Biblioteca')
    expect(t('songs', { count: 3 })).toBe('3 songs')
    expect(t('liked')).toBe('Liked songs')
    expect(onMissing.mock.calls.map(([missing]) => missing.key)).toEqual(['songs', 'liked'])
    // An empty English message may have an empty translation.
    const blank = defineMessages('blank', { nothing: '' })
    i18n.addCatalog('pt-BR', { blank: { nothing: '' } })
    expect(i18n.translator(blank)('nothing')).toBe('')
    expect(onMissing).toHaveBeenCalledTimes(2)
  })

  it('shows English for a translation that doesn’t parse, and reports it', async () => {
    const { i18n, t, onError } = setup()
    await i18n.setLocale('fr')
    expect(t('title')).toBe('Library')
    expect(t('title')).toBe('Library')
    expect(t('liked')).toBe('Titres likés')
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      locale: 'fr',
      namespace: 'library',
      key: 'title',
    })
    expect(onError.mock.calls[0]?.[0].problem).toContain('Expected an argument name')
  })

  it('reports values the code didn’t pass', () => {
    const { t, onError } = setup()
    expect((t as (key: string) => string)('songs')).toBe('{count}')
    expect(onError).toHaveBeenCalledWith({
      locale: 'en',
      namespace: 'library',
      key: 'songs',
      problem: 'No value for {count}',
    })
  })

  it('shows the id of a key the source doesn’t have, and reports it', () => {
    const { t, onError } = setup()
    expect((t as (key: string) => string)('nope')).toBe('library.nope')
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      key: 'nope',
      problem: 'No message library.nope in the source locale',
    })
  })

  it('lets the latest switch win', async () => {
    const { i18n } = setup()
    const first = i18n.setLocale('de')
    const second = i18n.setLocale('pt')
    await Promise.all([first, second])
    expect(i18n.locale).toBe('pt')
  })

  it('stays put when a catalog fails to load, and may try again', async () => {
    const { i18n, load } = setup()
    await expect(i18n.setLocale('ja')).rejects.toThrow('no catalog for ja')
    expect(i18n.locale).toBe('en')
    catalogs.ja = { library: { title: 'ライブラリ' } }
    try {
      await i18n.setLocale('ja')
      expect(i18n.translator(library)('title')).toBe('ライブラリ')
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      delete catalogs.ja
    }
  })

  it('refuses locales it doesn’t know', async () => {
    const { i18n } = setup()
    await expect(i18n.setLocale('xx')).rejects.toThrow(RangeError)
    expect(() => createI18n({ locale: 'de' })).toThrow(RangeError)
  })

  it('preloads without switching', async () => {
    const { i18n, load } = setup()
    const listener = vi.fn()
    i18n.subscribe(listener)
    await i18n.load('de')
    expect(load).toHaveBeenCalledWith('de')
    expect(i18n.locale).toBe('en')
    expect(listener).not.toHaveBeenCalled()
  })

  it('merges added catalogs, telling listeners only when the current locale changes', async () => {
    const i18n = createI18n({ locales: ['de'], locale: 'de' })
    const t = i18n.translator(library)
    const listener = vi.fn()
    const unsubscribe = i18n.subscribe(listener)
    i18n.addCatalog('de', { library: { title: 'Bibliothek' } })
    i18n.addCatalog('de', { library: { liked: 'Lieblingssongs' } })
    expect(t('title')).toBe('Bibliothek')
    expect(t('liked')).toBe('Lieblingssongs')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    i18n.addCatalog('de', { library: { title: 'Mediathek' } })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(t('title')).toBe('Mediathek')
  })

  it('makes derived locales from the source messages, without loading or reporting', async () => {
    const shout = (nodes: readonly MessageNode[]): MessageNode[] =>
      nodes.map((node) => (typeof node === 'string' ? node.toUpperCase() : node))
    const { i18n, t, load, onMissing } = setup({ derived: { 'en-XA': shout, 'ar-XB': shout } })
    expect(i18n.locales).toContain('ar-XB')
    await i18n.setLocale('en-XA')
    expect(t('title')).toBe('LIBRARY')
    expect(t('liked')).toBe('LIKED SONGS')
    await i18n.setLocale('ar-XB')
    expect(i18n.direction).toBe('rtl')
    expect(load).not.toHaveBeenCalled()
    expect(onMissing).not.toHaveBeenCalled()
  })

  it('renders tags in rich messages, and reports a tag without a renderer', () => {
    const notes = defineMessages('notes', { read: 'Read <link>the notes</link>.' })
    const onError = vi.fn()
    const t = createI18n({ onError }).translator(notes)
    expect(t('read')).toBe('Read the notes.')
    expect(t.rich('read', { link: (children) => ({ href: '/notes', children }) })).toEqual([
      'Read ',
      { href: '/notes', children: ['the notes'] },
      '.',
    ])
    expect((t.rich as (key: string, values: object) => unknown)('read', {})).toEqual([
      'Read the notes.',
    ])
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ problem: 'No value for {link}' }),
    )
    expect(t.namespace).toBe(notes)
  })
})
