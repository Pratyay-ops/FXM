// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createI18n } from './i18n'
import { defineMessages } from './messages'
import { PSEUDO_LOCALES } from './pseudo'
import { findUntranslated, strictReporters } from './testing'

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
