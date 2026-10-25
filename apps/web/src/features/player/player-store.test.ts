import { describe, expect, it } from 'vitest'
import { usePlayerStore } from './player-store'

const player = () => usePlayerStore.getState()

describe('placeholder player store', () => {
  it('toggles between playing and paused', () => {
    expect(player().isPlaying).toBe(false)
    player().togglePlay()
    expect(player().isPlaying).toBe(true)
    player().togglePlay()
    expect(player().isPlaying).toBe(false)
  })

  it('keeps seeking inside the track', () => {
    player().seek(42)
    expect(player().position).toBe(42)
    player().seek(-5)
    expect(player().position).toBe(0)
    player().seek(10_000)
    expect(player().position).toBe(player().duration)
    player().seek(Number.NaN)
    expect(player().position).toBe(0)
  })

  it('cycles repeat: off, all, one, off', () => {
    const seen = [player().repeat]
    for (let i = 0; i < 3; i++) {
      player().cycleRepeat()
      seen.push(player().repeat)
    }
    expect(seen).toEqual(['off', 'all', 'one', 'off'])
  })

  it('restores the volume after unmuting', () => {
    player().setVolume(0.3)
    player().toggleMute()
    expect(player()).toMatchObject({ muted: true, volume: 0.3 })
    player().toggleMute()
    expect(player()).toMatchObject({ muted: false, volume: 0.3 })
  })

  it('treats volume zero as muted and unmutes to half volume', () => {
    player().setVolume(0)
    expect(player().muted).toBe(true)
    player().toggleMute()
    expect(player()).toMatchObject({ muted: false, volume: 0.5 })
  })
})
