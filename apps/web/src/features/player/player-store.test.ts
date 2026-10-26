import { testTracks } from '@fxm/player/testing'
import { describe, expect, it } from 'vitest'
import { setupTestPlayback } from '../now-playing/testing'
import { usePlayerStore } from './player-store'

const view = () => usePlayerStore.getState()

describe('player bar store', () => {
  it('shows an idle player while the queue is empty', () => {
    setupTestPlayback()
    expect(view()).toMatchObject({
      hasTrack: false,
      isPlaying: false,
      busy: false,
      position: 0,
      duration: 0,
    })
  })

  it('follows the player, in seconds', async () => {
    const { player, engine } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b'))
    engine.progress(42_500)
    expect(view()).toMatchObject({
      hasTrack: true,
      isPlaying: true,
      position: 42.5,
      duration: 180,
    })
    engine.emit('durationchange', 200_000)
    expect(view().duration).toBe(200)
  })

  it('plays and pauses the player', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a'), { autoplay: false })
    view().togglePlay()
    await expect.poll(() => view().isPlaying).toBe(true)
    view().togglePlay()
    expect(view().isPlaying).toBe(false)
    expect(player.getState().status).toBe('paused')
    view().play()
    await expect.poll(() => player.getState().status).toBe('playing')
  })

  it('seeks, in seconds, inside the track', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a'), { autoplay: false })
    view().seek(42)
    expect(player.getState().positionMs).toBe(42_000)
    view().seek(10_000)
    expect(view().position).toBe(180)
  })

  it('skips with next and previous', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    view().next()
    await expect.poll(() => player.getState().queue.index).toBe(1)
    view().previous()
    await expect.poll(() => player.getState().queue.index).toBe(0)
  })

  it('cycles repeat: off, all, one, off, and toggles shuffle', () => {
    const { player } = setupTestPlayback()
    const seen = [view().repeat]
    for (let i = 0; i < 3; i++) {
      view().cycleRepeat()
      seen.push(view().repeat)
    }
    expect(seen).toEqual(['off', 'all', 'one', 'off'])
    view().toggleShuffle()
    expect(view().shuffle).toBe(true)
    expect(player.getState().queue.shuffle).toBe(true)
  })

  it('restores the volume after unmuting', () => {
    const { player } = setupTestPlayback()
    view().setVolume(0.3)
    view().toggleMute()
    expect(view()).toMatchObject({ muted: true, volume: 0.3 })
    expect(player.getState().muted).toBe(true)
    view().toggleMute()
    expect(view()).toMatchObject({ muted: false, volume: 0.3 })
  })

  it('treats volume zero as muted and unmutes to half volume', () => {
    setupTestPlayback()
    view().setVolume(0)
    expect(view().muted).toBe(true)
    view().toggleMute()
    expect(view()).toMatchObject({ muted: false, volume: 0.5 })
  })
})
