import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tabs } from './tabs'

const ITEMS = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
] as const

function box(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 36,
    width,
    height: 36,
    x: left,
    y: 0,
  } as DOMRect
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Tabs', () => {
  it('scrolls the selected tab into its row, and only the row', () => {
    // A row 300 px wide; the tabs 120 px wide, 200 px apart, moved by the row's scroll.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tablist') return box(0, 300)
      const index = ['A', 'B', 'C'].indexOf(this.textContent ?? '')
      return box(index * 200 - (this.parentElement?.scrollLeft ?? 0), 120)
    })
    const scrollPage = vi.spyOn(window, 'scrollTo')
    const tabs = (value: 'a' | 'b' | 'c') => (
      <Tabs label="Kinds" items={ITEMS} value={value} onChange={() => {}} id="kinds" />
    )
    const { rerender } = render(tabs('c'))
    const row = screen.getByRole('tablist')
    // C spans 400 to 520 px: the row scrolls 220 px to show it.
    expect(row.scrollLeft).toBe(220)
    // B starts 20 px before the row's edge: the row scrolls back 20 px.
    rerender(tabs('b'))
    expect(row.scrollLeft).toBe(200)
    rerender(tabs('a'))
    expect(row.scrollLeft).toBe(0)
    // A tab in view moves nothing.
    row.scrollLeft = 150
    rerender(tabs('b'))
    expect(row.scrollLeft).toBe(150)
    expect(scrollPage).not.toHaveBeenCalled()
  })
})
