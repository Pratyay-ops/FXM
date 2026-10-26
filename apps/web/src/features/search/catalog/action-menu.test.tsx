import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Disc3, ListEnd, ListStart } from 'lucide-react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ActionMenu, type MenuAction } from './action-menu'

function renderMenu(items: readonly MenuAction[]) {
  const user = userEvent.setup()
  render(
    <MemoryRouter>
      <button type="button">Before</button>
      <ActionMenu label="More options for Neon Rain" items={items} />
    </MemoryRouter>,
  )
  return { user, trigger: screen.getByRole('button', { name: 'More options for Neon Rain' }) }
}

const actions = (playNext = vi.fn(), queue = vi.fn()): MenuAction[] => [
  { key: 'next', label: 'Play next', icon: ListStart, onSelect: playNext },
  { key: 'queue', label: 'Add to queue', icon: ListEnd, onSelect: queue },
  { key: 'album', label: 'Go to album', icon: Disc3, to: '/album/ytm:abc' },
]

describe('ActionMenu', () => {
  it('opens on click, focuses the first item and runs the one picked', async () => {
    const queue = vi.fn()
    const { user, trigger } = renderMenu(actions(vi.fn(), queue))
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    const menu = screen.getByRole('menu', { name: 'More options for Neon Rain' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', menu.id)
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toHaveFocus()

    await user.click(screen.getByRole('menuitem', { name: 'Add to queue' }))

    expect(queue).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('moves with the arrow keys, Home and End, and wraps around', async () => {
    const { user, trigger } = renderMenu(actions())
    trigger.focus()

    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Go to album' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Go to album' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Go to album' })).toHaveAttribute(
      'href',
      '/album/ytm:abc',
    )
  })

  it('closes on Escape or Tab, back on its button, and on a click elsewhere', async () => {
    const { user, trigger } = renderMenu(actions())
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Before' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renders nothing without items', () => {
    render(
      <MemoryRouter>
        <ActionMenu label="More options for Neon Rain" items={[]} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('button', { name: /More options/ })).not.toBeInTheDocument()
  })
})
