import { FxmError } from '@fxm/core'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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

async function renderEmbed(options: HarnessOptions & { layout?: EmbedLayout }) {
  const harness = createHarness(options)
  const user = userEvent.setup()
  render(
    <EmbedApp controller={harness.controller} layout={options.layout ?? 'card'} origin={ORIGIN} />,
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
    expect(screen.getByRole('link', { name: 'Open in FXM (opens a new tab)' })).toHaveAttribute(
      'href',
      `${ORIGIN}/app/`,
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

  it('shows the install hint for YouTube content without Lite', async () => {
    await renderEmbed({ target: targetOf(SONG_A), capabilities: CAPABILITIES.free })
    expect(screen.getByText('A song from YouTube Music')).toBeVisible()
    const status = screen.getByRole('status')
    expect(within(status).getByText(/Add the free FXM Connect extension/)).toBeVisible()
    const link = within(status).getByRole('link', { name: 'Get FXM' })
    expect(link).toHaveAttribute('href', `${ORIGIN}/#get`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument()
  })

  it('offers to try again after a passing failure', async () => {
    const harness = createHarness({ target: targetOf(SONG_A) })
    harness.youtubeProvider.errors.set(SONG_A.id, new FxmError('Network', 'Offline'))
    const user = userEvent.setup()
    render(<EmbedApp controller={harness.controller} layout="card" origin={ORIGIN} />)
    await act(() => harness.controller.start())
    expect(screen.getByText(/Couldn't load this/)).toBeVisible()

    harness.youtubeProvider.errors.clear()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await act(() => settle())
    expect(screen.getByRole('button', { name: `Play ${SONG_A.title}` })).toBeVisible()
  })

  it('credits a free-source track while it plays', async () => {
    const { user } = await renderEmbed({ target: targetOf(ARCHIVE_TRACK) })
    await user.click(screen.getByRole('button', { name: `Play ${ARCHIVE_TRACK.title}` }))
    await act(() => settle())
    expect(screen.getByRole('link', { name: 'Internet Archive' })).toHaveAttribute(
      'href',
      'https://archive.org/details/item',
    )
    expect(screen.getByRole('link', { name: 'Licence' })).toHaveAttribute('target', '_blank')
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
