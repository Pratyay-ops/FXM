// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createI18n } from './i18n'
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTime,
  formatTimeAgo,
} from './intl'
import { defineMessages } from './messages'
import { PSEUDO_LOCALES } from './pseudo'
import { findUntranslated, strictReporters, UNTRANSLATED_FORMAT_LOCALE } from './testing'

const player = defineMessages('player', {
  play: 'Play',
  by: 'By {artist}',
  credit: 'Lyrics from <link>LRCLIB</link>',
})

async function pseudoTranslator() {
  const i18n = createI18n({ derived: PSEUDO_LOCALES })
  await i18n.setLocale('en-XA')
  return i18n.translator(player)
}

describe('findUntranslated', () => {
  it('passes a screen whose text all comes from messages, values and rich parts included', async () => {
    const t = await pseudoTranslator()
    const credit = t
      .rich<'credit', { link: string }>('credit', {
        link: (children) => ({ link: children.join('') }),
      })
      .map((part) =>
        typeof part === 'string' ? part : `<a href="https://lrclib.net">${part.link}</a>`,
      )
      .join('')
    document.body.innerHTML = `
      <button aria-label="${t('play')}">${t('play')}</button>
      <p>${t('by', { artist: 'Radiohead' })}</p>
      <p>${credit}</p>
      <span>FXM</span><span>3:07</span>
      <script>const plain = 'English'</script>`
    expect(document.querySelector('a')?.textContent).toBe('ĻŔÇĻÎÎƁ')
    expect(findUntranslated(document.body)).toEqual([])
  })

  it('finds hard-coded text and attributes', async () => {
    const t = await pseudoTranslator()
    document.body.innerHTML = `
      <button aria-label="Close" title="${t('play')}">${t('play')}</button>
      <input placeholder="Search songs">
      <p>Nothing here yet</p>`
    expect(findUntranslated(document.body).map(({ text, where }) => `${where}: ${text}`)).toEqual([
      'aria-label: Close',
      'placeholder: Search songs',
      'text: Nothing here yet',
    ])
  })

  it('passes what Intl formats in UNTRANSLATED_FORMAT_LOCALE, but not English glued to it', async () => {
    const i18n = createI18n({ derived: PSEUDO_LOCALES })
    await i18n.setLocale('en-XA', UNTRANSLATED_FORMAT_LOCALE)
    const screen = (locale: string) => {
      const day = new Date(2026, 9, 26, 17, 30)
      document.body.innerHTML = `
        <span>${formatBytes(locale, 4_200_000)}</span>
        <span>${formatDate(locale, day)}</span>
        <time title="${formatTime(locale, day)}">${formatTimeAgo(locale, day.getTime() - 300_000, day)}</time>
        <span>${formatDuration(locale, 3900, 'short')}</span>
        <span>${formatPercent(locale, 0.42)}</span>
        <span>${formatNumber(locale, 3)} songs</span>`
      return findUntranslated(document.body).map(({ text }) => text)
    }
    expect(screen(i18n.formatLocale)).toEqual(['٣ songs'])
    // In English, all but the percentage would read as untranslated.
    expect(screen('en-US')).toEqual([
      '4.2 MB',
      'Oct 26, 2026',
      '5:30 PM',
      '5 minutes ago',
      '1 hr 5 min',
      '3 songs',
    ])
  })

  it('skips the data a test names', () => {
    document.body.innerHTML = '<p>Creep</p><p>Radiohead</p><p>https://example.com/a</p>'
    expect(
      findUntranslated(document.body, { ignore: ['Creep', /^https:/] }).map((f) => f.text),
    ).toEqual(['Radiohead'])
    expect(findUntranslated(document.body, { ignore: (text) => text.length > 0 })).toEqual([])
  })
})

describe('strictReporters', () => {
  it('make a test fail on a message it can’t show', async () => {
    const i18n = createI18n({
      locales: ['de'],
      load: async () => ({ player: { play: 'Abspielen' } }),
      ...strictReporters,
    })
    await i18n.setLocale('de')
    const t = i18n.translator(player)
    expect(t('play')).toBe('Abspielen')
    expect(() => t('by', { artist: 'Ann' })).toThrow('No de message for player.by')
    expect(() => (t as (key: string) => string)('credit')).toThrow(
      'No de message for player.credit',
    )
  })
})
