import { fakeYouTube, song } from '@fxm/sources/import/testing'
import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { resetImportRunner } from './runner'
import { fakeServices, renderWithServices } from './testing'

afterEach(() => resetImportRunner())

/** Two made-up songs in the fake catalog. */
const SONGS = [song('aaaaaaaaaaa', 'First', 'Band'), song('bbbbbbbbbbb', 'Second', 'Band')]

/**
 * A request budget that holds the import's searches until `open()`, and a Pause until
 * `letPauseThrough()`: until then, the Pause button's action is under way. `waiting` resolves
 * once the import waits for its first search.
 */
function heldSlots() {
  let open = () => {}
  let letPauseThrough = () => {}
  let started = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const pauseLetThrough = new Promise<void>((resolve) => {
    letPauseThrough = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const waitForBulkSlot = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      started()
      void opened.then(resolve)
      const stop = () => void pauseLetThrough.then(() => reject(signal.reason))
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
  return { open, letPauseThrough, waiting, waitForBulkSlot }
}

/** Fake services over the fake catalog, with `slots` as the request budget. */
function servicesWith(slots: ReturnType<typeof heldSlots>) {
  return fakeServices({
    youtube: fakeYouTube({ catalog: SONGS }),
    waitForBulkSlot: slots.waitForBulkSlot,
  })
}

/**
 * Imports a playlist file named `name` that lists {@link SONGS} from the Import page, and waits
 * until the import waits for its first search. Returns its card's title. Each test uses a name of
 * its own: for a moment, the library's query cache can still show the imports of the test before.
 */
async function startImport(
  user: UserEvent,
  slots: ReturnType<typeof heldSlots>,
  name: string,
): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: 'Import music' })
  await user.click(screen.getByRole('tab', { name: 'Playlist file' }))
  const file = new File(['Title,Artist\nFirst,Band\nSecond,Band'], `${name}.csv`, {
    type: 'text/csv',
  })
  await user.upload(screen.getByLabelText('Choose a CSV or M3U file'), file)
  await user.click(await screen.findByRole('button', { name: 'Start import' }))
  const title = await screen.findByRole('heading', { level: 3, name })
  await waitFor(() => expect(title).toHaveFocus())
  await slots.waiting
  return title
}

/** Records each change of `element`'s `disabled` and `aria-disabled` attributes. */
function recordDisabling(element: Element): string[] {
  const changes: string[] = []
  new MutationObserver((records) => {
    for (const { attributeName } of records) {
      if (attributeName) changes.push(`${attributeName}=${element.getAttribute(attributeName)}`)
    }
  }).observe(element, { attributeFilter: ['disabled', 'aria-disabled'] })
  return changes
}

describe('ImportControls', () => {
  it('keeps focus on Pause and Resume while they work, without disabling them', async () => {
    const slots = heldSlots()
    const { user } = renderWithServices('/import', servicesWith(slots))
    await startImport(user, slots, 'evening')
    const toggle = await screen.findByRole('button', { name: 'Pause importing evening' })
    const changes = recordDisabling(toggle)
    toggle.focus()

    await user.keyboard('{Enter}')
    // Pausing waits for the search under way: the button says so and keeps the focus, and
    // another press changes nothing.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-disabled', 'true'))
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAccessibleName('Pause importing evening')
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    slots.letPauseThrough()
    await waitFor(() => expect(toggle).toHaveAccessibleName('Resume importing evening'))
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'))
    expect(toggle).toHaveFocus()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(toggle).toHaveAccessibleName('Pause importing evening'))
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'))
    expect(toggle).toHaveFocus()
    // Browsers move focus off a button they disable: this one is never disabled.
    expect(changes).toContain('aria-disabled=true')
    expect(changes.filter((change) => change.startsWith('disabled='))).toEqual([])
  })

  it('moves focus to the title when the import finishes while its Pause button has focus', async () => {
    const slots = heldSlots()
    const { user } = renderWithServices('/import', servicesWith(slots))
    const title = await startImport(user, slots, 'morning')
    const toggle = await screen.findByRole('button', { name: 'Pause importing morning' })
    toggle.focus()

    slots.open()

    const list = screen.getByRole('region', { name: 'Your imports' })
    expect(await within(list).findByText('Done')).toBeInTheDocument()
    expect(toggle).not.toBeInTheDocument()
    await waitFor(() => expect(title).toHaveFocus())
  })
})
