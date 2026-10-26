import type { FocusEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealFocused } from './shelves'

afterEach(() => {
  document.body.replaceChildren()
})

/**
 * Focus moving into the item of a 320 px row that keeps 16 px clear on each side, the item
 * laid out from `left` to `right`. Returns how the item was scrolled into view, if it was.
 */
function focusItemAt(left: number, right: number) {
  const row = document.createElement('ul')
  const item = document.createElement('li')
  const button = document.createElement('button')
  item.append(button)
  row.append(item)
  document.body.append(row)
  row.style.scrollPaddingLeft = '16px'
  row.style.scrollPaddingRight = '16px'
  row.getBoundingClientRect = () => ({ left: 0, right: 320 }) as DOMRect
  item.getBoundingClientRect = () => ({ left, right }) as DOMRect
  const scrollIntoView = vi.fn()
  item.scrollIntoView = scrollIntoView
  revealFocused({ currentTarget: row, target: button } as unknown as FocusEvent<HTMLElement>)
  return scrollIntoView
}

describe('revealFocused', () => {
  it('leaves an item that shows whole where it is', () => {
    expect(focusItemAt(16, 160)).not.toHaveBeenCalled()
    expect(focusItemAt(160, 304)).not.toHaveBeenCalled()
  })

  it('scrolls an item that shows only in part into view, either side', () => {
    expect(focusItemAt(176, 320)).toHaveBeenCalledWith({ inline: 'start', block: 'nearest' })
    expect(focusItemAt(277, 421)).toHaveBeenCalledWith({ inline: 'start', block: 'nearest' })
    expect(focusItemAt(-100, 44)).toHaveBeenCalledWith({ inline: 'start', block: 'nearest' })
  })

  it('does nothing when the row itself takes focus', () => {
    const row = document.createElement('ul')
    document.body.append(row)
    expect(() =>
      revealFocused({ currentTarget: row, target: row } as unknown as FocusEvent<HTMLElement>),
    ).not.toThrow()
  })
})
