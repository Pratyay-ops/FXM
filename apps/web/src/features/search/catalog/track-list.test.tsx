import { currentQueueItem, parseId } from '@fxm/core'
import { testStream } from '@fxm/player/testing'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preferReducedMotion } from '../../../test/media'
import { setupTestPlayback, testCandidate } from '../../now-playing/testing'
import { playbackFromPlayer } from '../actions'
import { renderCatalog, resetCatalogState } from '../testing'

// The pages are lazy chunks and the machine running the tests may be busy.
const SLOW = { timeout: 5000 }

afterEach(() => resetCatalogState())

/** The catalog at `path` with the fake catalog, playing through the app's player (with fakes). */
function renderPlaying(path: string) {
  const playback = setupTestPlayback()
  const page = renderCatalog(path, { actions: { playback: playbackFromPlayer(playback.player) } })
  return { ...playback, ...page }
}

function rows(list: HTMLElement): HTMLElement[] {
  return within(list).getAllByRole('listitem')
}

/** The rows marked as the current track's. */
function marked(list: HTMLElement): HTMLElement[] {
  return rows(list).filter((row) => row.getAttribute('aria-current') === 'true')
}

/** The marker's bars in `row`, if it has them. */
function bars(row: HTMLElement): SVGElement | null {
  return row.querySelector('svg[data-now-playing]')
}

function playButton(row: HTMLElement): HTMLElement {
  return within(row).getByRole('button', { name: /^Play / })
}

describe('the catalog’s track lists', () => {
  it('mark the song that plays on an album, in place of its number, and follow the player', async () => {
    const { user, player } = renderPlaying('/album/ytm:alb-neon-harbor')
    const list = await screen.findByRole('list', { name: 'Tracks' }, SLOW)
    expect(marked(list)).toEqual([])
    const second = rows(list)[1] as HTMLElement
    const name = playButton(second).getAttribute('aria-label') ?? ''

    await user.click(playButton(second))

    await vi.waitFor(() => expect(player.getState().status).toBe('playing'))
    expect(marked(list)).toEqual([second])
    const title = within(second).getByRole('button', { name: `${name}. Now playing` })
    expect(title).toHaveClass('text-accent')
    expect(bars(second)).toHaveAttribute('data-now-playing', 'playing')
    expect(bars(second)).toHaveAttribute('data-moving')
    // The bars take the number's place on screen; screen readers still hear the number.
    expect(second).toHaveTextContent(/^2/)
    expect(rows(list).filter((row) => bars(row) !== null)).toEqual([second])

    // The player moves on: so does the marker.
    await act(() => player.next())
    const third = rows(list)[2] as HTMLElement
    expect(marked(list)).toEqual([third])
    expect(playButton(second)).toHaveAccessibleName(name)
    expect(playButton(second)).not.toHaveClass('text-accent')

    // Paused, the song stays marked, with still bars, and says so.
    act(() => player.pause())
    expect(marked(list)).toEqual([third])
    expect(playButton(third)).toHaveAccessibleName(/\. Paused$/)
    expect(bars(third)).toHaveAttribute('data-now-playing', 'paused')
    expect(bars(third)).not.toHaveAttribute('data-moving')

    // Once the queue is empty, nothing is marked.
    await act(() => player.setQueue([]))
    expect(marked(list)).toEqual([])
    expect(rows(list).filter((row) => bars(row) !== null)).toEqual([])
    expect(list).toBeInTheDocument()
  })

  it('mark the Spotify song that was tapped, not the same recording on YouTube Music', async () => {
    const { user, player, resolver, router } = renderPlaying('/album/spotify:alb-neon-harbor')
    // Spotify has no audio: each song plays the YouTube Music recording of the same name.
    resolver.handler = (item) => ({
      stream: testStream(item.track.title),
      candidate: testCandidate(parseId(item.track.id).nativeId, { title: item.track.title }),
    })
    const spotify = await screen.findByRole('list', { name: 'Tracks' }, SLOW)
    const second = rows(spotify)[1] as HTMLElement

    await user.click(playButton(second))

    await vi.waitFor(() =>
      expect(currentQueueItem(player.getState().queue)?.candidate?.source).toBe('ytm'),
    )
    expect(marked(spotify)).toEqual([second])
    expect(playButton(second)).toHaveAccessibleName(/\. Now playing$/)

    // YouTube Music's copy of the album lists that recording, under the same title.
    await act(() => router.navigate('/album/ytm:alb-neon-harbor'))
    const youtube = await screen.findByRole('list', { name: 'Tracks' }, SLOW)
    expect(youtube).not.toBe(spotify)
    expect(within(youtube).getAllByText('YouTube Music').length).toBeGreaterThan(0)
    expect(playButton(rows(youtube)[1] as HTMLElement)).toHaveAccessibleName(
      (playButton(second).getAttribute('aria-label') ?? '').replace(/\. Now playing$/, ''),
    )
    expect(marked(youtube)).toEqual([])
    expect(youtube).toBeInTheDocument()
  })

  it('put the marker over the artwork in a list without numbers', async () => {
    const { user, player } = renderPlaying('/artist/ytm:art-nova-lane')
    const list = await screen.findByRole('list', { name: 'Popular songs' }, SLOW)
    const first = rows(list)[0] as HTMLElement

    await user.click(playButton(first))

    await vi.waitFor(() => expect(player.getState().status).toBe('playing'))
    expect(marked(list)).toEqual([first])
    // Over the cover, on its scrim: in the cover's frame, not in a number's.
    const marker = bars(first)
    expect(marker?.parentElement).toHaveClass('absolute', 'inset-0')
    expect(playButton(first)).toHaveAccessibleName(/\. Now playing$/)
    expect(list).toBeInTheDocument()
  })

  it('keep the bars still when the user asks for reduced motion', async () => {
    preferReducedMotion()
    const { user, player } = renderPlaying('/album/ytm:alb-neon-harbor')
    const list = await screen.findByRole('list', { name: 'Tracks' }, SLOW)
    const second = rows(list)[1] as HTMLElement

    await user.click(playButton(second))

    await vi.waitFor(() => expect(player.getState().status).toBe('playing'))
    expect(marked(list)).toEqual([second])
    expect(playButton(second)).toHaveAccessibleName(/\. Now playing$/)
    const marker = bars(second)
    expect(marker).toHaveAttribute('data-now-playing', 'playing')
    expect(marker).not.toHaveAttribute('data-moving')
    for (const bar of marker?.querySelectorAll('rect') ?? []) {
      expect(bar.getAttribute('class')).not.toMatch(/animate-/)
    }
    expect(list).toBeInTheDocument()
  })
})
