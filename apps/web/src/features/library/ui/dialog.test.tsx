import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Dialog } from './dialog'

function NameDialog() {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="New playlist">
      <input aria-label="Name" defaultValue="Road trip" />
    </Dialog>
  )
}

describe('Dialog', () => {
  it('stays open when a text selection is dragged out of it onto the backdrop', async () => {
    const user = userEvent.setup()
    render(<NameDialog />)
    const dialog = screen.getByRole('dialog', { name: 'New playlist' })

    // Pressed in the field, released over the backdrop: the browser clicks the <dialog>.
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByRole('textbox', { name: 'Name' }) },
      { target: dialog },
      { keys: '[/MouseLeft]', target: dialog },
    ])
    expect(screen.getByRole('dialog', { name: 'New playlist' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Road trip')

    // Pressed and released on the backdrop: that closes it, like Escape.
    await user.click(dialog)
    expect(screen.queryByRole('dialog', { name: 'New playlist' })).not.toBeInTheDocument()
  })
})
