import { testTrack, testTracks } from '@fxm/player/testing'
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

    // The library's like button loads just after: until then it is a disabled stand-in.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled())
  })

  it('likes the current track, and follows the queue to the next one', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    const user = userEvent.setup()
    render(<LikeButton />)
    const like = () => screen.getByRole('button', { name: 'Like' })
    await waitFor(() => expect(like()).toBeEnabled())

    await user.click(like())

    await waitFor(() => expect(like()).toHaveAttribute('aria-pressed', 'true'))
    expect(await getLibrary().isLiked(testTrack('a').id)).toBe(true)
    expect(await getLibrary().isLiked(testTrack('b').id)).toBe(false)

    await act(() => player.next())

    await waitFor(() => expect(like()).toHaveAttribute('aria-pressed', 'false'))
  })
})
