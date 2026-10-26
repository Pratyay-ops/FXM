import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from './tabs'

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'].map((value) => ({ value, label: `Tab ${value}` }))

function rect(left: number, right: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 36,
    width: right - left,
    height: 36,
    toJSON: () => ({}),
  } as DOMRect
}

/** A 320 px strip of 100 px tabs, 8 px apart, that scrolls sideways. */
function stubStripLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'tablist') return rect(0, 320)
    const strip = this.parentElement
    const index = strip ? [...strip.children].indexOf(this) : 0
    const left = index * 108 - (strip?.scrollLeft ?? 0)
    return rect(left, left + 100)
  })
}

describe('Tabs', () => {
  it('scrolls the strip to a selected tab out of view, and only the strip', () => {
    stubStripLayout()
    const scrollPage = vi.spyOn(window, 'scrollTo')
    const { rerender } = render(
      <Tabs label="Library" id="t" items={ITEMS} value="f" onChange={() => {}} />,
    )
    const strip = screen.getByRole('tablist', { name: 'Library' })
    // Tab f spans 540–640: the strip scrolls right until it ends at 320.
    expect(strip.scrollLeft).toBe(320)
    expect(screen.getByRole('tab', { name: 'Tab f' })).toHaveAttribute('aria-selected', 'true')

    // A tab already in view doesn't move the strip; one off to the left does.
    rerender(<Tabs label="Library" id="t" items={ITEMS} value="e" onChange={() => {}} />)
    expect(strip.scrollLeft).toBe(320)
    rerender(<Tabs label="Library" id="t" items={ITEMS} value="a" onChange={() => {}} />)
    expect(strip.scrollLeft).toBe(0)
    expect(scrollPage).not.toHaveBeenCalled()
  })
})
