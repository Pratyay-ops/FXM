import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import indexHtml from '../../../index.html?raw'
import { MARK_BAR_WIDTH, MARK_BARS, MARK_GRADIENT } from '../../../pwa/icons'
import { LogoMark } from '../../components/ui/logo'

describe('app icons', () => {
  it('draw the same mark as the logo in the app', () => {
    const { container } = render(<LogoMark />)
    const bars = [...container.querySelectorAll('g rect')].map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      height: Number(rect.getAttribute('height')),
    }))
    expect(bars).toEqual(MARK_BARS)
    for (const rect of container.querySelectorAll('g rect')) {
      expect(rect.getAttribute('width')).toBe(String(MARK_BAR_WIDTH))
    }
    const stops = [...container.querySelectorAll('stop')].map((stop) =>
      stop.getAttribute('stop-color'),
    )
    expect(stops).toEqual(MARK_GRADIENT)
  })

  it('give iOS a Home Screen icon and name', () => {
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="FXM" />')
  })
})
