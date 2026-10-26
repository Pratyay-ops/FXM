import { describe, expect, it } from 'vitest'
import { formatToParts, formatToString } from './format'
import { createI18n } from './i18n'
import { defineMessages } from './messages'
import { parseMessage } from './parse'
import { accented, accentText, bidi, PSEUDO_LOCALES, PSEUDO_MARKS } from './pseudo'

const show = (message: string, values = {}, derive = accented) =>
  formatToString(derive(parseMessage(message)), { locale: 'en', values })

describe('accentText', () => {
  it('accents every Latin letter and doubles the vowels', () => {
    expect(accentText('Settings')).toBe('Šééţţîîñĝš')
    expect(accentText('ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz')).toBe(
      'ÅÅƁÇÐÉÉƑĜĤÎÎĴĶĻṀÑÖÖÞǪŔŠŢÛÛṼŴẊÝÝŽ ååƀçðééƒĝĥîîĵķļɱñööþǫŕšţûûṽŵẋýýž',
    )
  })

  it('leaves everything else as it is', () => {
    expect(accentText('1:05 – “ok”? ü 中文')).toBe('1:05 – “ööķ”? ü 中文')
  })

  it('makes English about a third longer', () => {
    const sample =
      'FXM plays the YouTube Music catalog, and free music from the Internet Archive, in any browser.'
    const ratio = Array.from(show(sample)).length / sample.length
    expect(ratio).toBeGreaterThan(1.3)
    expect(ratio).toBeLessThan(1.45)
  })
})

describe('accented', () => {
  it('brackets the message and accents its text, not its values', () => {
    expect(show('By {artist}', { artist: 'Radiohead' })).toBe('⟦Ɓýý Radiohead⟧')
  })

  it('accents every option of plurals and selects, keeping #', () => {
    const songs = '{n, plural, =0 {No songs} one {# song} other {# songs}}'
    expect([0, 1, 5].map((n) => show(songs, { n }))).toEqual([
      '⟦Ñöö šööñĝš⟧',
      '⟦1 šööñĝ⟧',
      '⟦5 šööñĝš⟧',
    ])
    expect(show('{k, select, a {Yes} other {No}}', { k: 'a' })).toBe('⟦ÝÝééš⟧')
  })

  it('keeps tags, accenting what they enclose', () => {
    const nodes = accented(parseMessage('Read <link>the notes</link>'))
    const parts = formatToParts(nodes, {
      locale: 'en',
      tag: (name, children) => ({ name, children }),
    })
    expect(parts).toEqual(['⟦Ŕééååð ', { name: 'link', children: ['ţĥéé ñööţééš'] }, '⟧'])
  })

  it('marks both ends with the marks the test helpers look for', () => {
    expect(show('Play').startsWith(PSEUDO_MARKS.start)).toBe(true)
    expect(show('Play').endsWith(PSEUDO_MARKS.end)).toBe(true)
  })
})

describe('bidi', () => {
  it('wraps each piece of text in a right-to-left override, leaving values and blanks', () => {
    expect(show('By {artist}', { artist: 'Radiohead' }, bidi)).toBe('\u202eBy \u202cRadiohead')
    expect(show('{a} {b}', { a: 'x', b: 'y' }, bidi)).toBe('x y')
  })
})

describe('PSEUDO_LOCALES', () => {
  it('names the two pseudo-locales by the tags Android and Chromium use', () => {
    expect(Object.keys(PSEUDO_LOCALES)).toEqual(['en-XA', 'ar-XB'])
  })
})

describe('the pseudo-locales in an instance', () => {
  it('show every message derived, in the direction of each', async () => {
    const library = defineMessages('library', {
      title: 'Library',
      songs: '{count, plural, one {# song} other {# songs}}',
    })
    const i18n = createI18n({ derived: PSEUDO_LOCALES })
    const t = i18n.translator(library)
    await i18n.setLocale('en-XA')
    expect(t('title')).toBe('⟦Ļîîƀŕååŕýý⟧')
    expect(t('songs', { count: 2 })).toBe('⟦2 šööñĝš⟧')
    expect(i18n.direction).toBe('ltr')
    await i18n.setLocale('ar-XB')
    expect(t('title')).toBe('\u202eLibrary\u202c')
    expect(i18n.direction).toBe('rtl')
  })
})
