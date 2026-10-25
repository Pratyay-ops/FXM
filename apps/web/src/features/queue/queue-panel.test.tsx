import { FxmError, formatId, type Track } from '@fxm/core'
import { testTracks } from '@fxm/player/testing'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestPlayback, spotifyTrack, testCandidate } from '../now-playing/testing'
import { useQueueReviewStore } from './review-store'

const titles = (items: readonly { track: Track }[]) => items.map((item) => item.track.title)

/** Renders the queue tab of Now playing and waits for it. */
async function renderQueue() {
  const rendered = renderApp('/now-playing?tab=queue')
  await screen.findByRole('heading', { level: 1, name: 'Now playing' })
  return rendered
}

/** The rows of "Next up". */
function nextUp() {
  const section = screen.getByRole('region', { name: 'Next up' })
  return within(section).queryAllByRole('listitem')
}

/** Gives every row of "Next up" a layout: 60 px tall, one under the other. */
function layOutRows() {
  nextUp().forEach((row, index) => {
    row.getBoundingClientRect = () => new DOMRect(0, index * 60, 400, 60)
  })
}

describe('queue panel', () => {
  it('shows an empty queue with a way to find something to play', async () => {
    setupTestPlayback()
    await renderQueue()

    expect(screen.getByRole('heading', { name: 'Your queue is empty' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find something to play' })).toHaveAttribute(
      'href',
      '/search',
    )
    // The setting shows where it matters: with the songs that need review.
    expect(screen.queryByRole('switch', { name: 'Play best guesses' })).not.toBeInTheDocument()
  })

  it('lists the current song and the songs up next, in play order', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), {
      startIndex: 1,
      autoplay: false,
      context: { type: 'album', id: formatId('ytm', 'album', 'MPREb_1'), title: 'An album' },
    })
    await renderQueue()

    const current = screen.getByRole('region', { name: 'Now playing' })
    expect(within(current).getByText('b')).toBeInTheDocument()
    expect(nextUp().map((row) => within(row).getAllByRole('button')[1])).toEqual([
      screen.getByRole('button', { name: 'Play c c artist' }),
    ])
    expect(screen.getByText('An album')).toBeInTheDocument()
  })

  it('plays a song when it is selected', async () => {
    const { player, resolver } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Play c c artist' }))

    expect(titles(player.getState().queue.items.slice(player.getState().queue.index))).toEqual([
      'c',
    ])
    await expect.poll(() => resolver.log).toEqual(['c:play#0'])
  })

  it('moves a song with the arrow keys on its handle, and keeps focus on it', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c', 'd'), { autoplay: false })
    const { user } = await renderQueue()

    const handle = screen.getByRole('button', { name: 'Move b' })
    expect(handle).toHaveAccessibleDescription(/buttons that move the song.*up or down arrow key/)
    handle.focus()
    await user.keyboard('{ArrowDown}')

    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'b', 'd'])
    expect(screen.getByRole('button', { name: 'Move b' })).toHaveFocus()
    expect(screen.getByText('Moved b to position 2 of 3.')).toBeInTheDocument()

    await user.keyboard('{End}')
    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'd', 'b'])
    await user.keyboard('{Home}')
    expect(titles(player.getState().queue.items)).toEqual(['a', 'b', 'c', 'd'])
    await user.keyboard('{ArrowUp}')
    // Already at the top of "Next up": the current song stays first.
    expect(titles(player.getState().queue.items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves a song by dragging its handle', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c', 'd'), { autoplay: false })
    await renderQueue()
    layOutRows()
    const handle = screen.getByRole('button', { name: 'Move b' })

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 30 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
    // While dragging, the row follows the pointer and the row it passed makes room.
    expect(nextUp()[0]).toHaveStyle({ transform: 'translateY(70px)' })
    expect(nextUp()[1]).toHaveStyle({ transform: 'translateY(-60px)' })
    expect(titles(player.getState().queue.items)).toEqual(['a', 'b', 'c', 'd'])

    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 160 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 160 })

    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'd', 'b'])
    expect(screen.getByText('Moved b to position 3 of 3.')).toBeInTheDocument()
    for (const row of nextUp()) expect(row.style.transform).toBe('')
  })

  it('moves a song with one tap per step, from the buttons its handle shows', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c', 'd'), { autoplay: false })
    const { user } = await renderQueue()
    const handle = screen.getByRole('button', { name: 'Move c' })
    expect(handle).toHaveAttribute('aria-expanded', 'false')

    await user.click(handle)

    expect(handle).toHaveAttribute('aria-expanded', 'true')
    const moves = within(screen.getByRole('group', { name: 'Move c' }))
    await user.click(moves.getByRole('button', { name: 'Up' }))
    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'b', 'd'])
    expect(screen.getByText('Moved c to position 1 of 3.')).toBeInTheDocument()
    // At the top: "Up" stays focused, and does nothing more.
    const up = screen.getByRole('button', { name: 'Up' })
    expect(up).toHaveFocus()
    expect(up).toHaveAttribute('aria-disabled', 'true')
    await user.click(up)
    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'b', 'd'])

    await user.click(screen.getByRole('button', { name: 'Down' }))
    await user.click(screen.getByRole('button', { name: 'Down' }))
    expect(titles(player.getState().queue.items)).toEqual(['a', 'b', 'd', 'c'])
    expect(screen.getByRole('button', { name: 'Down' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Play next' }))
    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'b', 'd'])

    // Escape closes them, and so does the handle.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Move c' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move c' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Move c' }))
    expect(screen.getByRole('group', { name: 'Move c' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Move c' }))
    expect(screen.queryByRole('group', { name: 'Move c' })).not.toBeInTheDocument()
  })

  it('doesn’t show the move buttons after a drag', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    await renderQueue()
    layOutRows()
    const handle = screen.getByRole('button', { name: 'Move b' })

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 30 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 })
    // The press ends in a click, which is no tap.
    fireEvent.click(handle)

    expect(titles(player.getState().queue.items)).toEqual(['a', 'c', 'b'])
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('leaves the order alone for a press without a drag, a cancelled drag, or Escape', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    await renderQueue()
    layOutRows()
    const handle = screen.getByRole('button', { name: 'Move b' })

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 30 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 32 })

    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 30 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 100 })
    fireEvent.pointerCancel(handle, { pointerId: 2 })

    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientY: 30 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 100 })
    fireEvent.keyDown(handle, { key: 'Escape' })
    fireEvent.pointerUp(handle, { pointerId: 3, clientY: 100 })

    expect(titles(player.getState().queue.items)).toEqual(['a', 'b', 'c'])
    for (const row of nextUp()) expect(row.style.transform).toBe('')
  })

  it('removes a song, and moves focus to the next one', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Remove b from the queue' }))

    expect(titles(player.getState().queue.items)).toEqual(['a', 'c'])
    expect(screen.getByRole('button', { name: 'Remove c from the queue' })).toHaveFocus()
    expect(screen.getByText('Removed b from the queue.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove c from the queue' }))
    expect(screen.getByRole('heading', { name: 'Next up' })).toHaveFocus()
  })

  it('clears the songs up next', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Clear the songs up next' }))

    expect(titles(player.getState().queue.items)).toEqual(['a'])
    expect(screen.getByText(/Nothing up next/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Next up' })).toHaveFocus()
  })

  it('shows only the first hundred songs up next until asked for all', async () => {
    const { player } = setupTestPlayback()
    const names = Array.from({ length: 130 }, (_, index) => `t${index}`)
    await player.setQueue(testTracks(...names), { autoplay: false })
    const { user } = await renderQueue()
    expect(nextUp()).toHaveLength(100)

    await user.click(screen.getByRole('button', { name: 'Show all 129 songs' }))

    expect(nextUp()).toHaveLength(129)
  })
})

describe('songs that need review', () => {
  async function queueWithGuesses() {
    const playback = setupTestPlayback()
    const [s1, s2] = [spotifyTrack('S1'), spotifyTrack('S2')]
    await playback.player.setQueue([...testTracks('a'), s1, s2], { autoplay: false })
    act(() => {
      playback.policy.reportNeedsReview(s1, testCandidate('g1', { title: 'Guess 1' }))
      playback.policy.reportNeedsReview(s2, testCandidate('g2', { title: 'Guess 2' }))
    })
    return { ...playback, s1, s2 }
  }

  it('marks them, and approves them all in one tap', async () => {
    const { player, policy } = await queueWithGuesses()
    const { user } = await renderQueue()

    expect(screen.getByRole('heading', { name: '2 songs need review' })).toBeInTheDocument()
    expect(screen.getAllByText('Needs review')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Approve all' }))

    expect(screen.queryByText('Needs review')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /need review/ })).not.toBeInTheDocument()
    expect(policy.pins.map((pin) => pin.candidate.title)).toEqual(['Guess 1', 'Guess 2'])
    expect(player.getState().queue.items.map((item) => item.candidate?.ref)).toEqual([
      undefined,
      'g1',
      'g2',
    ])
  })

  it('lists them with their best guesses, to approve one by one', async () => {
    const { policy, s2 } = await queueWithGuesses()
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Review' }))
    const dialog = await screen.findByRole('dialog', { name: 'Review best guesses' })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(within(dialog).getByText('Guess 2')).toBeInTheDocument()
    // The guess's length next to the song's own.
    expect(within(dialog).getAllByText('g2 artist · 3:01 (original 3:00)')).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: 'Approve the best guess for S2' }))

    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
    expect(policy.pins).toEqual([
      { track: s2, candidate: testCandidate('g2', { title: 'Guess 2' }) },
    ])
    expect(screen.getByRole('heading', { name: '1 song needs review' })).toBeInTheDocument()
    // The row went with the focused button: the other row's "Approve" has the focus.
    const approveS1 = within(dialog).getByRole('button', { name: 'Approve the best guess for S1' })
    expect(approveS1).toHaveFocus()

    await user.click(approveS1)

    expect(within(dialog).getByRole('button', { name: 'Done' })).toHaveFocus()
  })

  it('plays a best guess from the review list, without approving it', async () => {
    const { player, policy, resolver } = await queueWithGuesses()
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Review' }))
    const dialog = await screen.findByRole('dialog', { name: 'Review best guesses' })
    await user.click(within(dialog).getByRole('button', { name: 'Play the best guess for S2' }))

    await expect.poll(() => resolver.requests.length).toBe(1)
    expect(resolver.requests[0]?.item.candidate?.ref).toBe('g2')
    expect(player.getState().queue.index).toBe(2)
    expect(policy.pins).toEqual([])
    expect(
      await within(dialog).findByRole('button', { name: 'Pause the best guess for S2' }),
    ).toBeInTheDocument()
  })

  it('offers other versions from the review list', async () => {
    const { policy, s1 } = await queueWithGuesses()
    policy.alternativesOf.set(s1.id, [testCandidate('alt', { title: 'Alternative' })])
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: 'Review' }))
    const review = await screen.findByRole('dialog', { name: 'Review best guesses' })
    await user.click(within(review).getByRole('button', { name: 'Other versions of S1' }))

    const versions = await screen.findByRole('dialog', { name: 'Choose the right version' })
    expect(within(versions).getByRole('heading', { name: 'Best guess' })).toBeInTheDocument()
    await user.click(await within(versions).findByRole('button', { name: /Alternative/ }))

    expect(policy.pins.map((pin) => pin.candidate.ref)).toEqual(['alt'])
    expect(useQueueReviewStore.getState().entries[s1.id]).toBeUndefined()
    // S1's row went: the next row's "Approve" has the focus.
    expect(
      within(review).getByRole('button', { name: 'Approve the best guess for S2' }),
    ).toHaveFocus()
  })

  it('plays one with its best guess when it is selected, still marked as a guess', async () => {
    const { player, resolver } = await queueWithGuesses()
    const { user } = await renderQueue()

    await user.click(screen.getByRole('button', { name: /^Play S1 .*Needs review$/ }))

    await expect.poll(() => resolver.requests.length).toBe(1)
    expect(resolver.requests[0]?.item.candidate?.ref).toBe('g1')
    expect(player.getState().queue.index).toBe(1)
    expect(screen.getByRole('heading', { name: '2 songs need review' })).toBeInTheDocument()
  })

  it('lets best guesses play with the setting in the notice', async () => {
    const { policy } = await queueWithGuesses()
    const { user } = await renderQueue()
    const notice = screen.getByRole('region', { name: '2 songs need review' })

    await user.click(within(notice).getByRole('switch', { name: 'Play best guesses' }))

    expect(policy.playBestGuesses).toBe(true)
    expect(screen.getByRole('heading', { name: '2 songs play a best guess' })).toBeInTheDocument()
    expect(screen.getAllByText('Best guess')).toHaveLength(2)
  })

  it('marks the current song as a best guess too, and says when it couldn’t play', async () => {
    const { player, policy, resolver } = setupTestPlayback()
    const s1 = spotifyTrack('S1')
    await player.setQueue([s1], { autoplay: false })
    act(() => policy.reportNeedsReview(s1, testCandidate('g1')))
    resolver.handler = () => {
      throw new FxmError('NotFound', 'Gone')
    }
    await renderQueue()
    const current = within(screen.getByRole('region', { name: 'Now playing' }))
    expect(current.getByText('Needs review')).toBeInTheDocument()

    await act(() => player.play())

    expect(current.getByText('Couldn’t play')).toBeInTheDocument()
  })
})
