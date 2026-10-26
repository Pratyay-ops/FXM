import { testTracks } from '@fxm/player/testing'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { setupTestPlayback } from '../now-playing/testing'
import { LikeButton, SeekBar } from './controls'

describe('the seek bar', () => {
  it('shows where the thumb is dragged, and seeks only when it is let go', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a'), { autoplay: false })
    render(<SeekBar />)
    const slider = screen.getByRole('slider', { name: 'Seek' })

    fireEvent.input(slider, { target: { value: '42' } })
    fireEvent.input(slider, { target: { value: '61' } })

    expect(slider).toHaveAttribute('aria-valuetext', '1:01 of 3:00')
    expect(player.getState().positionMs).toBe(0)

    // Let go (or a key press): the native change event.
    fireEvent.change(slider, { target: { value: '61' } })

    expect(player.getState().positionMs).toBe(61_000)
    expect(slider).toHaveAttribute('aria-valuetext', '1:01 of 3:00')
  })

  it('goes back to the position when the thumb is let go where it was', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a'), { autoplay: false })
    render(<SeekBar />)
    const slider = screen.getByRole('slider', { name: 'Seek' })

    fireEvent.input(slider, { target: { value: '42' } })
    fireEvent.pointerUp(slider)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 3:00')
    expect(player.getState().positionMs).toBe(0)
  })
})

describe('the like button', () => {
  it('is off while nothing plays', async () => {
    const { player } = setupTestPlayback()
    render(<LikeButton />)
    expect(screen.getByRole('button', { name: 'Like' })).toBeDisabled()

    await act(() => player.setQueue(testTracks('a'), { autoplay: false }))

    // The library's like button loads just after: a disabled stand-in until then.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled())
  })

  it('saves the current track in the library, and follows the queue', async () => {
    const { player } = setupTestPlayback()
    const [first, second] = testTracks('a', 'b')
    if (!first || !second) throw new Error('two test tracks')
    await player.setQueue([first, second], { autoplay: false })
    const user = userEvent.setup()
    render(<LikeButton />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Like', pressed: false }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(await getLibrary().isLiked(first.id)).toBe(true)

    await act(() => player.next())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false'),
    )
    expect(await getLibrary().isLiked(second.id)).toBe(false)
  })
})
