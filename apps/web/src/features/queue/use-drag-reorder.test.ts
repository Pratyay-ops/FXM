import { describe, expect, it } from 'vitest'
import { type DragState, dropIndex, keyTarget, onlyAppended, rowShift } from './use-drag-reorder'

// Four rows, 60 px apart: centres at 30, 90, 150 and 210.
const centres = [30, 90, 150, 210]

describe('dropIndex', () => {
  it.each([
    // [from, dragged row's centre, index once dropped]
    [0, 30, 0],
    [0, 89, 0],
    [0, 91, 1],
    [0, 151, 2],
    [0, 500, 3],
    [3, 209, 3],
    [3, 149, 2],
    [3, 89, 1],
    [3, -40, 0],
    [1, 90, 1],
  ])('drops row %i with its centre at %i at index %i', (from, centre, expected) => {
    expect(dropIndex(centres, from, centre)).toBe(expected)
  })
})

describe('rowShift', () => {
  const down: DragState = { from: 0, to: 2, offset: 125, step: 60 }
  const up: DragState = { from: 3, to: 1, offset: -130, step: 60 }

  it('moves the dragged row with the pointer', () => {
    expect(rowShift(0, down)).toBe(125)
    expect(rowShift(3, up)).toBe(-130)
  })

  it('moves the rows it passed by one step the other way', () => {
    expect([1, 2, 3].map((index) => rowShift(index, down))).toEqual([-60, -60, 0])
    expect([0, 1, 2].map((index) => rowShift(index, up))).toEqual([0, 60, 60])
  })

  it('leaves every other row where it is before the row moves far enough', () => {
    const still: DragState = { from: 1, to: 1, offset: 10, step: 60 }
    expect([0, 2, 3].map((index) => rowShift(index, still))).toEqual([0, 0, 0])
  })
})

describe('keyTarget', () => {
  it('moves one step with the arrow keys, to the ends with Home and End', () => {
    expect(keyTarget('ArrowUp', 2, 5)).toBe(1)
    expect(keyTarget('ArrowDown', 2, 5)).toBe(3)
    expect(keyTarget('Home', 2, 5)).toBe(0)
    expect(keyTarget('End', 2, 5)).toBe(4)
  })

  it('ignores moves past the ends, moves to where the row is, and other keys', () => {
    expect(keyTarget('ArrowUp', 0, 5)).toBeUndefined()
    expect(keyTarget('ArrowDown', 4, 5)).toBeUndefined()
    expect(keyTarget('Home', 0, 5)).toBeUndefined()
    expect(keyTarget('End', 4, 5)).toBeUndefined()
    expect(keyTarget('Enter', 2, 5)).toBeUndefined()
    expect(keyTarget('toString', 2, 5)).toBeUndefined()
  })
})

describe('onlyAppended', () => {
  const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('tells rows added at the end, which leave every row where it was', () => {
    expect(onlyAppended([a, b], [a, b, c])).toBe(true)
    expect(onlyAppended([a, b], [a, b])).toBe(true)
    expect(onlyAppended([], [a])).toBe(true)
  })

  it('tells them from rows that moved, went or changed', () => {
    expect(onlyAppended([a, b], [b, a, c])).toBe(false)
    expect(onlyAppended([a, b], [a])).toBe(false)
    expect(onlyAppended([a, b], [c, a, b])).toBe(false)
    expect(onlyAppended([a, b], [a, { ...b }])).toBe(false)
    expect(onlyAppended('rows', 'rows!')).toBe(false)
  })
})
