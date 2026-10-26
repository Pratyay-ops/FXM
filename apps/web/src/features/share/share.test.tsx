import { formatId } from '@fxm/core'
import { act, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WIRED_SOURCES } from '../../embed/wired'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { useSettingsStore } from '../settings/settings-store'
import { PREFERS_LIGHT_QUERY } from '../settings/theme'
import { embedCode, escapeAttribute, shareOrigin } from './embed-code'
import { ShareDialogHost } from './share-dialog'
import { shareMenuItems } from './share-menu'
import { canShare, openShareDialog, useShareStore } from './share-store'

const ALBUM = { kind: 'album', id: formatId('ytm', 'album', 'MPREb_abc') } as const
/** An album of the fake catalog, whose page opens the dialog. */
const NEON_HARBOR = { kind: 'album', id: formatId('ytm', 'album', 'alb-neon-harbor') } as const

// The pages are lazy chunks and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  resetCatalogState()
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
  it('are menu entries only for what an embed can show', () => {
    const info = { title: 'Pablo Honey' }
    expect(shareMenuItems(ALBUM.id, info)).toMatchObject([{ key: 'share', label: 'Share' }])
    expect(shareMenuItems(formatId('archive', 'playlist', 'a/b'), info)).toHaveLength(1)
    expect(shareMenuItems(formatId('ytm', 'artist', 'UC1'), info)).toEqual([])
    expect(shareMenuItems(formatId('spotify', 'album', '4aawyAB9vmqN3uQ7FjRGTy'), info)).toEqual([])
  })

  it('are offered in production builds only once the embed is out, for what it can play', () => {
    expect(canShare(ALBUM, { PROD: false })).toBe(true)
    // Until the embed is released (RELEASED.embed, with the site's AVAILABLE.embed), nothing.
    expect(canShare(ALBUM, { PROD: true })).toBe(false)
    expect(canShare(ALBUM, { PROD: true }, true)).toBe(WIRED_SOURCES.has('ytm'))
    const archive = { kind: 'album', id: formatId('jamendo', 'album', '123') } as const
    expect(canShare(archive, { PROD: true }, true)).toBe(WIRED_SOURCES.has('jamendo'))
    // The tests run as a development build: the dialog can be tried.
    expect(canShare(ALBUM)).toBe(true)
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
  /** Opens a page of the fake catalog and its "More options" menu's Share entry. */
  async function openFromPage(path: string, name: string, kind: 'album' | 'playlist') {
    const app = renderCatalog(path)
    await app.user.click(
      await screen.findByRole('button', { name: `More options for ${name}` }, SLOW),
    )
    await app.user.click(await screen.findByRole('menuitem', { name: 'Share' }))
    const dialog = screen.getByRole('dialog', { name: `Share this ${kind}` })
    const code = within(dialog).getByRole('textbox', { name: 'Embed code' }) as HTMLTextAreaElement
    return { ...app, dialog, code }
  }

  const openFromAlbumPage = () => openFromPage('/album/ytm:alb-neon-harbor', 'Neon Harbor', 'album')

  it('opens from an album page with the code, a preview and the options', async () => {
    const { dialog, code } = await openFromAlbumPage()
    expect(dialog).toHaveAccessibleDescription(/Put a player for "Neon Harbor" on your website/)
    expect(code.value).toBe(
      embedCode(
        NEON_HARBOR,
        { layout: 'card', theme: 'auto', mode: 'music' },
        'Neon Harbor',
        'https://fxmusic.pages.dev',
      ).html,
    )
    expect(code).toHaveAttribute('readonly')
    const preview = within(dialog).getByTestId('embed-preview')
    expect(preview).toHaveAttribute('aria-hidden', 'true')
    expect(preview).toHaveStyle({ height: '380px' })
    // The preview shows what the page shows: the album, its artist and its tracks.
    expect(within(preview).getAllByText('Neon Harbor')[0]).toBeInTheDocument()
    expect(within(preview).getAllByText('Nova Lane')[0]).toBeInTheDocument()
    expect(within(preview).getAllByText('Night Ferry')[0]).toBeInTheDocument()
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
      'https://fxmusic.pages.dev/embed/album/ytm:alb-neon-harbor',
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

  it('previews the player in the chosen theme', async () => {
    const { user, dialog } = await openFromAlbumPage()
    const preview = within(dialog).getByTestId('embed-preview')
    // Auto shows what this device's own setting gives.
    const system = window.matchMedia(PREFERS_LIGHT_QUERY).matches ? 'light' : 'dark'
    expect(preview).toHaveAttribute('data-theme', system)
    await user.click(within(dialog).getByRole('radio', { name: 'Light' }))
    expect(preview).toHaveAttribute('data-theme', 'light')
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }))
    expect(preview).toHaveAttribute('data-theme', 'dark')
  })

  it('says what a player on a page loads before anyone presses play', async () => {
    const { dialog } = await openFromAlbumPage()
    expect(
      within(dialog).getByText(/loads the album's details and cover art from its source/),
    ).toHaveTextContent(/privacy notice/)
  })

  it('stays open under StrictMode, which runs its effect twice', async () => {
    act(() => useShareStore.getState().open({ target: ALBUM, info: { title: 'Pablo Honey' } }))
    render(
      <StrictMode>
        <ShareDialogHost />
      </StrictMode>,
    )
    // A close event queued by the first cleanup would arrive now.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(screen.getByRole('dialog', { name: 'Share this album' })).toHaveAttribute('open')
    expect(useShareStore.getState().request?.target).toEqual(ALBUM)
  })

  it('closes from its button', async () => {
    const { user, dialog } = await openFromAlbumPage()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useShareStore.getState().request).toBeUndefined()
  })

  it('opens from a playlist page with what the page shows', async () => {
    const { dialog, code } = await openFromPage(
      '/playlist/ytm:pl-indie-sunrise',
      'Indie Sunrise',
      'playlist',
    )
    expect(dialog).toHaveAccessibleDescription(/Put a player for "Indie Sunrise" on your website/)
    expect(code.value).toContain(
      'src="https://fxmusic.pages.dev/embed/playlist/ytm:pl-indie-sunrise"',
    )
    // Its owner, and how many songs it has in all, not only those loaded so far.
    const preview = within(dialog).getByTestId('embed-preview')
    expect(within(preview).getAllByText('FXM Picks')[0]).toBeInTheDocument()
    expect(within(preview).getByText(/120 songs/)).toBeInTheDocument()
  })

  it('is not offered where no embed can show the page', async () => {
    // A Spotify playlist: the embed plays no Spotify content.
    const { user } = renderCatalog('/playlist/spotify:pl-study-hours')
    const name = 'More options for Lo-fi Study Hours'
    await user.click(await screen.findByRole('button', { name }, SLOW))
    const menu = await screen.findByRole('menu', { name })
    expect(within(menu).getByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Share' })).not.toBeInTheDocument()
  })
})
