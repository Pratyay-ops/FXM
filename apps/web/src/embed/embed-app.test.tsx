import { FxmError } from '@fxm/core'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { asBrowser, USER_AGENTS } from '../features/connect/testing'
import { EmbedPlayerView } from './components/layouts'
import { EmbedApp, InvalidEmbed } from './embed-app'
import type { EmbedLayout } from './target'
import { CAPABILITIES } from './testing/fake-platform'
import {
  ALBUM,
  ARCHIVE_TRACK,
  createHarness,
  type HarnessOptions,
  SONG_A,
  SONG_B,
  settle,
  targetOf,
} from './testing/harness'
import { previewView } from './view'

const ORIGIN = 'https://fxmusic.pages.dev'

async function renderEmbed(
  options: HarnessOptions & { layout?: EmbedLayout; standalone?: boolean },
) {
  const harness = createHarness(options)
  const user = userEvent.setup()
  render(
    <EmbedApp
      controller={harness.controller}
      layout={options.layout ?? 'card'}
      origin={ORIGIN}
      standalone={options.standalone ?? false}
    />,
  )
  await act(() => harness.controller.start())
  return { ...harness, user }
}

describe('EmbedApp', () => {
  it('shows a skeleton while it loads', () => {
    const harness = createHarness({ target: targetOf(SONG_A) })
    render(<EmbedApp controller={harness.controller} layout="card" origin={ORIGIN} />)
    expect(screen.getByRole('main', { name: 'FXM player' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument()
    expect(document.title).toBe('FXM player')
  })

  it('plays a song from its card and shows its progress', async () => {
    const { user, engine } = await renderEmbed({ target: targetOf(SONG_A) })
    const main = screen.getByRole('main', { name: `FXM player: ${SONG_A.title}` })
    expect(main).not.toHaveAttribute('aria-busy')
    expect(within(main).getByRole('heading', { level: 1, name: SONG_A.title })).toBeVisible()
    expect(screen.getByText('Song')).toBeVisible()
    expect(screen.getByText('The Testers')).toBeVisible()
    expect(document.title).toBe(`${SONG_A.title} · FXM player`)
    // A track has no app page: the mark searches the app for it.
    expect(screen.getByRole('link', { name: 'Open in FXM (opens a new tab)' })).toHaveAttribute(
      'href',
      `${ORIGIN}/app/search?q=Song+A+The+Testers`,
    )
    expect(screen.queryByRole('list', { name: 'Tracks' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: `Play ${SONG_A.title}` }))
    await act(() => settle())
    act(() => engine.progress(65_000))

    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute(
      'aria-valuetext',
      '1:05 of 3:20',
    )
  })

  it('plays an album from its track list and skips', async () => {
    const { user, controller } = await renderEmbed({ target: targetOf(ALBUM) })
    expect(screen.getByText('Album · 3 songs')).toBeVisible()
    const list = screen.getByRole('list', { name: 'Tracks' })
    const rows = within(list).getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => !row.hasAttribute('aria-current'))).toBe(true)

    await user.click(
      within(list).getByRole('button', { name: `Play ${SONG_B.title} by The Testers` }),
    )
    await act(() => settle())

    expect(controller.getState().player?.queue.index).toBe(1)
    expect(within(list).getAllByRole('button')[1]).toHaveAttribute('aria-current', 'true')
    // The card says what plays now, above the seek bar.
    expect(
      screen.getByText(
        (_text, element) =>
          element?.tagName === 'P' && element.textContent === `${SONG_B.title} · The Testers`,
      ),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Next track' }))
    await act(() => settle())
    expect(controller.getState().player?.queue.index).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Previous track' }))
    await act(() => settle())
    expect(controller.getState().player?.queue.index).toBe(1)
  })

  it('fits an album in one row in the compact layout', async () => {
    const { user } = await renderEmbed({ target: targetOf(ALBUM), layout: 'compact' })
    expect(screen.getByRole('heading', { level: 1, name: ALBUM.name })).toHaveClass('sr-only')
    expect(screen.queryByRole('list', { name: 'Tracks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: `Play ${ALBUM.name}` }))
    await act(() => settle())
    expect(screen.getByText(SONG_A.title)).toBeVisible()
    expect(screen.getByText(`The Testers · ${ALBUM.name}`)).toBeVisible()
  })

  it('offers FXM for YouTube content without Lite in a frame, where FXM Connect never reaches', async () => {
    await renderEmbed({ target: targetOf(SONG_A), capabilities: CAPABILITIES.free })
    expect(screen.getByText('A song from YouTube Music')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      "YouTube Music can't play in this player in this browser. Open it in FXM instead.",
    )
    expect(screen.queryByText(/FXM Connect/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Get FXM/ })).not.toBeInTheDocument()
    // The mark, and the message's action in its two shapes, all to the app (the song's title
    // isn't known, so its home).
    const links = screen.getAllByRole('link', { name: 'Open in FXM (opens a new tab)' })
    expect(links).toHaveLength(3)
    for (const link of links) expect(link).toHaveAttribute('href', `${ORIGIN}/app/`)
    expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument()
  })

  it('shows the install hint, worded for the device, on a page of its own', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    const chrome = await renderEmbed({
      target: targetOf(SONG_A),
      capabilities: CAPABILITIES.free,
      standalone: true,
    })
    const status = screen.getByRole('status')
    expect(within(status).getByText(/Add the free FXM Connect extension/)).toBeVisible()
    // An icon button on narrow players, words from 25rem: one shows at a time, by CSS.
    const links = screen.getAllByRole('link', { name: 'Get FXM (opens a new tab)' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', `${ORIGIN}/#get`)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    chrome.controller.destroy()
    cleanup()

    // No browser on an iPhone can add FXM Connect, and the hint says so.
    asBrowser(USER_AGENTS.iphone)
    await renderEmbed({
      target: targetOf(SONG_A),
      capabilities: CAPABILITIES.free,
      standalone: true,
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      "YouTube Music needs FXM Connect, which isn't available on iPhone and iPad.",
    )
    expect(screen.getAllByRole('link', { name: 'Get FXM (opens a new tab)' })).toHaveLength(2)
  })

  it("tells why a track didn't play in few words, next to the play button", async () => {
    const { user, ladder } = await renderEmbed({ target: targetOf(SONG_A) })
    ladder.errors.set('songA', new FxmError('BotCheck', 'Sign in to confirm'))
    await user.click(screen.getByRole('button', { name: `Play ${SONG_A.title}` }))
    await act(() => settle())

    expect(screen.getByRole('status')).toHaveTextContent('YouTube wants to check this browser.')
    expect(screen.getByRole('button', { name: `Play ${SONG_A.title}` })).toBeVisible()
    expect(screen.queryByRole('slider', { name: 'Seek' })).not.toBeInTheDocument()
    const open = screen.getAllByRole('link', { name: 'Open in FXM (opens a new tab)' })
    // The mark, and the message's action in its two shapes.
    expect(open).toHaveLength(3)
  })

  it('fits a message in the compact layout without the FXM mark', async () => {
    const framed = await renderEmbed({
      target: targetOf(SONG_A),
      capabilities: CAPABILITIES.free,
      layout: 'compact',
    })
    expect(screen.getByRole('status')).toHaveTextContent("YouTube Music can't play here.")
    // The message's action in its two shapes, and no mark.
    expect(screen.getAllByRole('link', { name: 'Open in FXM (opens a new tab)' })).toHaveLength(2)
    framed.controller.destroy()
    cleanup()

    asBrowser(USER_AGENTS.chromeWindows)
    await renderEmbed({
      target: targetOf(SONG_A),
      capabilities: CAPABILITIES.free,
      layout: 'compact',
      standalone: true,
    })
    // Only FXM Connect until the desktop or Android app is out (RELEASED).
    expect(screen.getByRole('status')).toHaveTextContent('Needs FXM Connect to play here.')
    expect(screen.getAllByRole('link', { name: 'Get FXM (opens a new tab)' })).toHaveLength(2)
    expect(
      screen.queryByRole('link', { name: 'Open in FXM (opens a new tab)' }),
    ).not.toBeInTheDocument()
  })

  it('offers to try again after a passing failure', async () => {
    const harness = createHarness({ target: targetOf(SONG_A) })
    harness.youtubeProvider.errors.set(SONG_A.id, new FxmError('Network', 'Offline'))
    const user = userEvent.setup()
    render(<EmbedApp controller={harness.controller} layout="card" origin={ORIGIN} />)
    await act(() => harness.controller.start())
    expect(screen.getByText(/Couldn't load this/)).toBeVisible()

    harness.youtubeProvider.errors.clear()
    const [tryAgain] = screen.getAllByRole('button', { name: 'Try again' })
    if (tryAgain === undefined) throw new Error('No "Try again" button')
    await user.click(tryAgain)
    await act(() => settle())
    expect(screen.getByRole('button', { name: `Play ${SONG_A.title}` })).toBeVisible()
  })

  it.each(['card', 'compact'] as const)(
    'credits a free-source track while it plays, in the %s layout',
    async (layout) => {
      const { user } = await renderEmbed({ target: targetOf(ARCHIVE_TRACK), layout })
      await user.click(screen.getByRole('button', { name: `Play ${ARCHIVE_TRACK.title}` }))
      await act(() => settle())
      expect(
        screen.getByRole('link', { name: 'Internet Archive (opens a new tab)' }),
      ).toHaveAttribute('href', 'https://archive.org/details/item')
      const licence = screen.getByRole('link', { name: 'Licence (opens a new tab)' })
      expect(licence).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/')
      expect(licence).toHaveAttribute('target', '_blank')
    },
  )

  it('draws its own edge in a frame, and sits centred at its size as a page of its own', async () => {
    const framed = await renderEmbed({ target: targetOf(SONG_A) })
    expect(screen.getByRole('main')).toHaveClass('ring-1', 'ring-inset')
    expect(screen.queryByTestId('embed-box')).not.toBeInTheDocument()
    framed.controller.destroy()
    cleanup()

    await renderEmbed({ target: targetOf(SONG_A), standalone: true })
    expect(screen.getByTestId('embed-box')).toHaveStyle({ height: '232px' })
    expect(screen.getByRole('main')).not.toHaveClass('ring-1')
  })
})

describe('EmbedPlayerView as a preview', () => {
  it('renders without a main landmark or a heading, and plays nothing', async () => {
    const view = previewView(
      targetOf(ALBUM),
      'card',
      { title: ALBUM.name, tracks: [SONG_A, SONG_B] },
      ORIGIN,
    )
    const user = userEvent.setup()
    render(<EmbedPlayerView view={view} as="div" />)
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText(ALBUM.name)).toBeVisible()
    // Without actions, its buttons do nothing.
    await user.click(screen.getByRole('button', { name: `Play ${ALBUM.name}` }))
    expect(screen.getByRole('button', { name: `Play ${ALBUM.name}` })).toBeVisible()
  })
})

describe('InvalidEmbed', () => {
  it('says the link is broken and links to the app', () => {
    render(<InvalidEmbed origin={ORIGIN} />)
    expect(screen.getByText(/This player link isn't valid/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open FXM' })).toHaveAttribute('href', `${ORIGIN}/app/`)
  })
})
