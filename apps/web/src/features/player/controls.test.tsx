import { testTracks } from '@fxm/player/testing'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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

    expect(screen.getByRole('button', { name: 'Like' })).toBeEnabled()
  })
})
