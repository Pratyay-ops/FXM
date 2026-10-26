import type { EntityId } from '@fxm/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { usePlaylistView } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import { track, tracks } from '../../test/library-fixtures'
import { preferReducedMotion } from '../../test/media'
import { setupTestPlayback } from '../now-playing/testing'
import { TrackList } from './track-list'

// Counts the rows that render, through their cover art: one per row body.
const covers = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./cover-art', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cover-art')>()
  return {
    ...actual,
    CoverArt: (props: Parameters<typeof actual.CoverArt>[0]) => {
      covers.renders++
      return actual.CoverArt(props)
    },
  }
})

function LivePlaylist({ id }: { id: EntityId<'playlist'> }) {
  const live = usePlaylistView(id)
  if (live.status !== 'ready' || live.data === undefined) return null
  const { playlist, rows } = live.data
  return (
    <TrackList
      listId={id}
      rows={rows}
      undo={playlist.undo}
      kind="playlist"
      name={playlist.name}
      empty={null}
    />
  )
}

/** A playlist of `count` songs, shown live, played through the app's player (with fakes). */
async function renderPlaying(count: number) {
  const playback = setupTestPlayback()
  const id = await getLibrary().createPlaylist({ name: 'Mix', tracks: tracks(count) })
  const user = userEvent.setup()
  render(<LivePlaylist id={id} />)
  const list = await screen.findByRole('list', { name: 'Songs in Mix' })
  return { ...playback, user, list }
}

/** The rows marked as the current track's. */
function marked(list: HTMLElement): HTMLElement[] {
  return within(list)
    .getAllByRole('listitem')
    .filter((row) => row.getAttribute('aria-current') === 'true')
}

/** The marker's bars in `row`, if it has them. */
function bars(row: HTMLElement | undefined): SVGElement | null {
  return row?.querySelector('svg[data-now-playing]') ?? null
}

describe('TrackList', { timeout: 30_000 }, () => {
  it('marks the song that plays and says whether it plays or is paused', async () => {
    const { user, list, player } = await renderPlaying(5)
    expect(marked(list)).toEqual([])

    await user.click(within(list).getByRole('button', { name: 'Play Song 2 by Artist 2' }))

    await waitFor(() => expect(player.getState().status).toBe('playing'))
    const second = within(list).getAllByRole('listitem')[1]
    expect(marked(list)).toEqual([second])
    const title = within(list).getByRole('button', { name: 'Play Song 2 by Artist 2. Now playing' })
    expect(title).toHaveClass('text-accent')
    expect(bars(second)).toHaveAttribute('data-now-playing', 'playing')
    expect(bars(second)).toHaveAttribute('data-moving')

    act(() => player.pause())
    expect(marked(list)).toEqual([second])
    expect(within(list).getByRole('button', { name: 'Play Song 2 by Artist 2. Paused' })).toBe(
      title,
    )
    // Still bars, not colour alone: the marker stays while paused.
    for (const marker of second?.querySelectorAll('svg[data-now-playing]') ?? []) {
      expect(marker).toHaveAttribute('data-now-playing', 'paused')
      expect(marker).not.toHaveAttribute('data-moving')
    }

    await act(() => player.play(3))
    expect(marked(list)).toEqual([within(list).getAllByRole('listitem')[3]])
    expect(title).toHaveAccessibleName('Play Song 2 by Artist 2')
    expect(title).not.toHaveClass('text-accent')
  })

  it('re-renders no row on a playback tick, and only the rows a new track changes', async () => {
    const { user, list, player, engine } = await renderPlaying(60)
    await user.click(within(list).getByRole('button', { name: 'Play Song 30 by Artist 30' }))
    await waitFor(() => expect(marked(list)).toHaveLength(1))

    covers.renders = 0
    act(() => {
      for (let positionMs = 250; positionMs <= 10_000; positionMs += 250) {
        engine.progress(positionMs)
      }
    })
    expect(player.getState().positionMs).toBe(10_000)
    expect(covers.renders).toBe(0)

    // The next song: the row that loses the marker and the one that gains it.
    await act(() => player.next())
    expect(marked(list)).toEqual([within(list).getAllByRole('listitem')[30]])
    expect(covers.renders).toBe(2)

    covers.renders = 0
    act(() => player.pause())
    expect(covers.renders).toBe(1)
  })

  it('keeps the bars still when the user asks for reduced motion', async () => {
    preferReducedMotion()
    const { user, list, player } = await renderPlaying(3)

    await user.click(within(list).getByRole('button', { name: 'Play Song 1 by Artist 1' }))

    await waitFor(() => expect(player.getState().status).toBe('playing'))
    const [first] = within(list).getAllByRole('listitem')
    expect(marked(list)).toEqual([first])
    const markers = [...(first?.querySelectorAll('svg[data-now-playing]') ?? [])]
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) {
      expect(marker).toHaveAttribute('data-now-playing', 'playing')
      expect(marker).not.toHaveAttribute('data-moving')
    }
    expect(list).toBeInTheDocument()
  })

  it('re-renders only the rows a change touches, also with every write to the library', async () => {
    const id = await getLibrary().createPlaylist({ name: 'Mix', tracks: tracks(60) })
    render(<LivePlaylist id={id} />)
    const list = await screen.findByRole('list', { name: 'Songs in Mix' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(60)

    // A like changes one row.
    covers.renders = 0
    await getLibrary().like(track(30))
    await waitFor(() =>
      expect(within(list).getByRole('button', { name: 'Like Song 30' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(covers.renders).toBe(1)

    // A move changes no row: the positions come from a CSS counter.
    covers.renders = 0
    await getLibrary().moveItems(id, [track(1).id], 'bottom')
    await waitFor(() =>
      expect(within(list).getAllByRole('listitem').at(-1)).toHaveTextContent('Song 1'),
    )
    expect(covers.renders).toBe(0)
  })
})
