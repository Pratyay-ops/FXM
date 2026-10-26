import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NowPlayingBars, nowPlayingLabel, nowPlayingText } from './now-playing-marker'

/** The bars that `NowPlayingBars` drew in `container`. */
function barsIn(container: HTMLElement): SVGElement | null {
  return container.querySelector('svg[data-now-playing]')
}

/** How tall each bar stands: its inline transform. */
function heights(svg: SVGElement | null): (string | null)[] {
  return [...(svg?.querySelectorAll('rect') ?? [])].map((bar) => bar.getAttribute('style'))
}

describe('the now playing marker', () => {
  it('says how the current song stands, a failure in the words of the queue and player bar', () => {
    expect(nowPlayingText('playing')).toBe('Now playing')
    expect(nowPlayingText('paused')).toBe('Paused')
    expect(nowPlayingText('error')).toBe('Couldn’t play')
    expect(nowPlayingLabel('Play Copper Sun', 'error')).toBe('Play Copper Sun. Couldn’t play')
    expect(nowPlayingLabel('Play Copper Sun', undefined)).toBe('Play Copper Sun')
  })

  it('keeps the bars still, low and even, for a song that couldn’t play, as when paused', () => {
    const { container, rerender } = render(<NowPlayingBars status="error" />)
    const failed = barsIn(container)
    expect(failed).toHaveAttribute('data-now-playing', 'error')
    expect(failed).not.toHaveAttribute('data-moving')
    for (const bar of failed?.querySelectorAll('rect') ?? []) {
      expect(bar.getAttribute('class')).not.toMatch(/animate-/)
    }
    const still = heights(failed)
    expect(still).toHaveLength(4)
    expect(new Set(still)).toEqual(new Set(['transform: scaleY(0.4);']))

    rerender(<NowPlayingBars status="paused" />)
    expect(heights(barsIn(container))).toEqual(still)

    rerender(<NowPlayingBars status="playing" />)
    expect(barsIn(container)).toHaveAttribute('data-moving')
    expect(new Set(heights(barsIn(container))).size).toBeGreaterThan(1)
  })
})
