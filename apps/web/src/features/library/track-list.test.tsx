import type { EntityId } from '@fxm/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePlaylistView } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import { track, tracks } from '../../test/library-fixtures'
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

describe('TrackList', { timeout: 30_000 }, () => {
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
