// @vitest-environment happy-dom
import { act, createElement, memo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n, type I18n } from './i18n'
import { defineMessages } from './messages'
import { I18nProvider, type ReactTranslator, useFormat, useI18n, useLocale, useT } from './react'

const player = defineMessages('player', {
  play: 'Play',
  queued: '{count, plural, one {# song} other {# songs}} in the queue',
  credit: 'Lyrics from <link>LRCLIB</link>, by <b>{author}</b>',
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function makeI18n(): I18n {
  return createI18n({
    locales: ['de'],
    load: async () => ({
      player: {
        play: 'Abspielen',
        queued: '{count, plural, one {# Titel} other {# Titel}} in der Warteschlange',
        credit: 'Liedtexte von <link>LRCLIB</link>, von <b>{author}</b>',
      },
    }),
  })
}

function render(i18n: I18n, element: ReactNode): void {
  act(() => root.render(createElement(I18nProvider, { i18n }, element)))
}

function Player({ count }: { count: number }): ReactNode {
  const t = useT(player)
  const { locale, direction } = useLocale()
  const format = useFormat()
  return createElement(
    'p',
    { lang: locale, dir: direction },
    `${t('play')} · ${t('queued', { count })} · ${format.duration(125)}`,
  )
}

describe('React bindings', () => {
  it('render the source messages, then follow a switch of locale', async () => {
    const i18n = makeI18n()
    render(i18n, createElement(Player, { count: 1234 }))
    expect(container.textContent).toBe('Play · 1,234 songs in the queue · 2:05')
    expect(container.querySelector('p')?.getAttribute('lang')).toBe('en')
    await act(() => i18n.setLocale('de'))
    expect(container.textContent).toBe('Abspielen · 1.234 Titel in der Warteschlange · 2:05')
    expect(container.querySelector('p')?.getAttribute('lang')).toBe('de')
  })

  it('render rich messages as elements, with no key warnings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Credit(): ReactNode {
      const t = useT(player)
      return createElement(
        'p',
        null,
        t.rich('credit', {
          author: 'Ann',
          link: (children) => createElement('a', { href: 'https://lrclib.net' }, children),
          b: (children) => createElement('strong', null, children),
        }),
      )
    }
    render(makeI18n(), createElement(Credit))
    expect(container.innerHTML).toBe(
      '<p>Lyrics from <a href="https://lrclib.net">LRCLIB</a>, by <strong>Ann</strong></p>',
    )
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('give memoized children a new translator when the locale changes', async () => {
    const i18n = makeI18n()
    const renders = vi.fn()
    const Label = memo(function Label({ t }: { t: ReactTranslator<typeof player.messages> }) {
      renders()
      return createElement('span', null, t('play'))
    })
    function Parent(): ReactNode {
      return createElement(Label, { t: useT(player) })
    }
    render(i18n, createElement(Parent))
    expect(container.textContent).toBe('Play')
    await act(() => i18n.setLocale('de'))
    expect(container.textContent).toBe('Abspielen')
    expect(renders).toHaveBeenCalledTimes(2)
  })

  it('need a provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Orphan(): ReactNode {
      useI18n()
      return null
    }
    expect(() => act(() => root.render(createElement(Orphan)))).toThrow(
      'useI18n() needs an <I18nProvider> above it',
    )
    error.mockRestore()
  })
})
