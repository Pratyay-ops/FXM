import { formatId } from '@fxm/core'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { useSettingsStore } from '../settings/settings-store'
import { embedCode, escapeAttribute, shareOrigin } from './embed-code'
import { pageEntityId } from './share-button'
import { openShareDialog, useShareStore } from './share-store'

const ALBUM = { kind: 'album', id: formatId('ytm', 'album', 'MPREb_abc') } as const

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  useShareStore.setState(useShareStore.getInitialState(), true)
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('embed code', () => {
  it("comes from FXM's public origin, or from a preview of it", () => {
    expect(shareOrigin('http://localhost:5173')).toBe('https://fxmusic.pages.dev')
    expect(shareOrigin('https://fxmusic.pages.dev')).toBe('https://fxmusic.pages.dev')
    expect(shareOrigin('https://develop.fxmusic.pages.dev')).toBe(
      'https://develop.fxmusic.pages.dev',
    )
    expect(shareOrigin('https://fxmusic.pages.dev.evil.example')).toBe('https://fxmusic.pages.dev')
    expect(shareOrigin('http://fxmusic.pages.dev')).toBe('https://fxmusic.pages.dev')
    expect(shareOrigin('not a url')).toBe('https://fxmusic.pages.dev')
  })

  it("is an iframe with the layout's height, a title and autoplay allowed", () => {
    expect(
      embedCode(
        ALBUM,
        { layout: 'card', theme: 'auto', mode: 'music' },
        'Pablo Honey',
        'https://fxmusic.pages.dev',
      ),
    ).toEqual({
      url: 'https://fxmusic.pages.dev/embed/album/ytm:MPREb_abc',
      height: 380,
      html: '<iframe title="FXM player: Pablo Honey" src="https://fxmusic.pages.dev/embed/album/ytm:MPREb_abc" width="100%" height="380" style="border:0;border-radius:12px" allow="autoplay" loading="lazy"></iframe>',
    })
    const compact = embedCode(
      { kind: 'track', id: formatId('ytm', 'track', 'abc') },
      { layout: 'compact', theme: 'light', mode: 'all' },
      'Song',
      'https://fxmusic.pages.dev',
    )
    expect(compact.height).toBe(80)
    expect(compact.html).toContain(
      'src="https://fxmusic.pages.dev/embed/track/ytm:abc?layout=compact&amp;theme=light&amp;mode=all"',
    )
  })

  it('escapes what it puts in attributes', () => {
    expect(escapeAttribute('"><script>alert(1)</script>&')).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;',
    )
    const html = embedCode(
      ALBUM,
      { layout: 'card', theme: 'auto', mode: 'music' },
      'A "quoted" <title>',
      'https://fxmusic.pages.dev',
    ).html
    expect(html).toContain('title="FXM player: A &quot;quoted&quot; &lt;title&gt;"')
    expect(html).not.toContain('<title>')
  })
})

describe('share entry points', () => {
  it('read the entity of an app page', () => {
    expect(pageEntityId('album', 'ytm:MPREb_abc')).toBe(ALBUM.id)
    expect(pageEntityId('playlist', 'archive:a/b')).toBe('archive:playlist:a/b')
    expect(pageEntityId('playlist', 'liked')).toBeUndefined()
    expect(pageEntityId('album', 'spotify:4aawyAB9vmqN3uQ7FjRGTy')).toBeUndefined()
    expect(pageEntityId('album', undefined)).toBeUndefined()
  })

  it('open the dialog only for what an embed can show', () => {
    expect(openShareDialog(formatId('ytm', 'artist', 'UC1'), { title: 'Artist' })).toBe(false)
    expect(useShareStore.getState().request).toBeUndefined()
    expect(openShareDialog(ALBUM.id, { title: 'Pablo Honey' })).toBe(true)
    expect(useShareStore.getState().request).toEqual({
      target: ALBUM,
      info: { title: 'Pablo Honey' },
    })
  })
})

describe('Share dialog', () => {
  async function openFromAlbumPage() {
    const app = renderApp('/album/ytm:MPREb_abc')
    await app.user.click(await screen.findByRole('button', { name: 'Share Album' }))
    const dialog = screen.getByRole('dialog', { name: 'Share this album' })
    const code = within(dialog).getByRole('textbox', { name: 'Embed code' }) as HTMLTextAreaElement
    return { ...app, dialog, code }
  }

  it('opens from an album page with the code, a preview and the options', async () => {
    const { dialog, code } = await openFromAlbumPage()
    expect(dialog).toHaveAccessibleDescription(/Put a player for "Album" on your website/)
    expect(code.value).toBe(
      embedCode(
        ALBUM,
        { layout: 'card', theme: 'auto', mode: 'music' },
        'Album',
        'https://fxmusic.pages.dev',
      ).html,
    )
    expect(code).toHaveAttribute('readonly')
    const preview = within(dialog).getByTestId('embed-preview')
    expect(preview).toHaveAttribute('aria-hidden', 'true')
    expect(preview).toHaveStyle({ height: '380px' })
    expect(within(dialog).getByRole('radio', { name: 'Card' })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'Auto' })).toBeChecked()
  })

  it("follows the layout, the theme and the app's catalog mode", async () => {
    act(() => useSettingsStore.getState().setCatalogMode('all'))
    const { user, dialog, code } = await openFromAlbumPage()
    expect(code.value).toContain('?mode=all')
    expect(within(dialog).getByText(/plays in Music \+ Video mode/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('radio', { name: 'Compact' }))
    await user.click(within(dialog).getByRole('radio', { name: 'Light' }))

    expect(code.value).toContain('?layout=compact&amp;theme=light&amp;mode=all')
    expect(code.value).toContain('height="80"')
    expect(within(dialog).getByTestId('embed-preview')).toHaveStyle({ height: '80px' })
  })

  /** Replaces the clipboard (after user-event, which installs a clipboard of its own). */
  function mockClipboard(writeText: (text: string) => Promise<void>) {
    const mock = vi.fn(writeText)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: mock }),
    })
    return mock
  }

  it('copies the code and the link', async () => {
    const { user, dialog, code } = await openFromAlbumPage()
    const writeText = mockClipboard(async () => {})

    await user.click(within(dialog).getByRole('button', { name: 'Copy embed code' }))
    expect(writeText).toHaveBeenLastCalledWith(code.value)
    expect(within(dialog).getByRole('status')).toHaveTextContent('Embed code copied')

    await user.click(within(dialog).getByRole('button', { name: 'Copy player link' }))
    expect(writeText).toHaveBeenLastCalledWith(
      'https://fxmusic.pages.dev/embed/album/ytm:MPREb_abc',
    )
    expect(within(dialog).getByRole('status')).toHaveTextContent('Player link copied')

    // A new option makes it a new code, not yet copied.
    await user.click(within(dialog).getByRole('radio', { name: 'Compact' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('')
  })

  it('selects the code when the browser refuses to copy it', async () => {
    const { user, dialog, code } = await openFromAlbumPage()
    mockClipboard(async () => {
      throw new DOMException('Denied', 'NotAllowedError')
    })
    const select = vi.spyOn(code, 'select')

    await user.click(within(dialog).getByRole('button', { name: 'Copy embed code' }))

    expect(select).toHaveBeenCalled()
    expect(within(dialog).getByRole('status')).toHaveTextContent(/Copying was blocked/)
  })

  it('closes from its button', async () => {
    const { user, dialog } = await openFromAlbumPage()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useShareStore.getState().request).toBeUndefined()
  })

  it('has no share button where no embed can show the page', async () => {
    renderApp('/playlist/liked')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: /^Share/ })).not.toBeInTheDocument()
  })
})
