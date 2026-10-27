import { testTracks } from '@fxm/player/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestLyrics, setupTestPlayback } from '../now-playing/testing'

// Both bars render; CSS shows the player bar from 768px and the mini player below.
const bars = () => screen.getAllByRole('region', { name: 'Player' })
/** The player bar, which comes first (Now playing has no mini player). */
const playerBar = () => within(bars()[0] as HTMLElement)
/** The mini player, which comes after the player bar. */
const miniPlayer = () => within(bars()[1] as HTMLElement)

/** Where the app is going: the page it shows, or the one a navigation is still loading. */
function destination(router: ReturnType<typeof renderApp>['router']): string {
  return (router.state.navigation.location ?? router.state.location).pathname
}

/** The page the app shows, with its query. */
function shown(router: ReturnType<typeof renderApp>['router']): string {
  const { pathname, search } = router.state.location
  return pathname + search
}

describe('the Queue button', () => {
  const queueButton = () => playerBar().getByRole('button', { name: 'Queue' })
  const library = () => screen.findByRole('heading', { level: 1, name: 'Your library' })

  it('is a toggle: pressed again, it closes the queue back to the page it opened on', async () => {
    setupTestPlayback()
    const { user, router } = renderApp('/library')
    await library()
    expect(queueButton()).toHaveAttribute('aria-pressed', 'false')

    await user.click(queueButton())

    expect(await screen.findByRole('heading', { name: 'Your queue is empty' })).toBeVisible()
    expect(shown(router)).toBe('/now-playing?tab=queue')
    expect(queueButton()).toHaveAttribute('aria-pressed', 'true')

    await user.click(queueButton())

    // Back, as the browser's Back button would go: the queue is ahead, not behind.
    expect(await library()).toBeVisible()
    expect(router.state.historyAction).toBe('POP')
    expect(shown(router)).toBe('/library')
    expect(queueButton()).toHaveAttribute('aria-pressed', 'false')
    expect(queueButton()).toHaveFocus()
  })

  it('opens and closes the queue with Enter and Space, keeping the focus', async () => {
    setupTestPlayback()
    const { user, router } = renderApp('/library')
    await library()

    queueButton().focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('heading', { name: 'Your queue is empty' })
    expect(queueButton()).toHaveFocus()
    expect(queueButton()).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard(' ')
    await library()
    expect(shown(router)).toBe('/library')
    expect(queueButton()).toHaveFocus()
    expect(queueButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('closes a queue opened by Now playing’s Queue tab to the lyrics', async () => {
    setupTestPlayback()
    const { user, router } = renderApp('/library')
    await library()
    await user.click(playerBar().getByRole('link', { name: 'Open now playing' }))
    await user.click(await screen.findByRole('tab', { name: 'Queue' }))
    expect(queueButton()).toHaveAttribute('aria-pressed', 'true')

    await user.click(queueButton())

    expect(shown(router)).toBe('/now-playing')
    expect(router.state.historyAction).toBe('REPLACE')
    expect(screen.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true')
    expect(queueButton()).toHaveAttribute('aria-pressed', 'false')

    // Opened by the button from there, it closes back to the lyrics too.
    await user.click(queueButton())
    expect(shown(router)).toBe('/now-playing?tab=queue')
    await user.click(queueButton())
    expect(shown(router)).toBe('/now-playing')
    expect(router.state.historyAction).toBe('POP')
  })

  it('closes a queue opened straight from a link to Home, without leaving FXM', async () => {
    setupTestPlayback()
    const { user, router } = renderApp('/now-playing?tab=queue')
    await screen.findByRole('heading', { name: 'Your queue is empty' })
    expect(queueButton()).toHaveAttribute('aria-pressed', 'true')

    await user.click(queueButton())

    expect(await screen.findByRole('heading', { level: 1, name: /^Good/ })).toBeVisible()
    expect(shown(router)).toBe('/')
    // In place of the queue: Back doesn't open it again.
    expect(router.state.historyAction).toBe('REPLACE')
    expect(queueButton()).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('the mini player', () => {
  it('has Like, Previous, Play and Next, off while nothing plays, as in the player bar', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1, name: /^Good/ })

    expect(bars()).toHaveLength(2)
    for (const region of bars()) {
      for (const name of ['Like', 'Previous', 'Play', 'Next']) {
        expect(within(region).getByRole('button', { name })).toBeDisabled()
      }
    }
  })

  it('steps the queue and pauses in place: only the track opens Now playing', async () => {
    const { player } = setupTestPlayback()
    // Now playing looks the lyrics up.
    setupTestLyrics()
    await player.setQueue(testTracks('One', 'Two', 'Three'))
    const { user, router } = renderApp('/')
    const mini = miniPlayer()

    await user.click(mini.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(player.getState().queue.index).toBe(1))
    expect(mini.getByRole('link', { name: 'Open now playing: Two by Two artist' })).toBeVisible()

    await user.click(mini.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(player.getState().queue.index).toBe(0))

    await user.click(mini.getByRole('button', { name: 'Pause' }))
    expect(player.getState().status).toBe('paused')
    expect(destination(router)).toBe('/')

    await user.click(mini.getByRole('link', { name: 'Open now playing: One by One artist' }))
    expect(destination(router)).toBe('/now-playing')
    expect(await screen.findByRole('heading', { level: 1, name: 'Now playing' })).toBeVisible()
  })

  it('takes the keyboard in reading order: the track, Like, Previous, Pause, Next', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue(testTracks('One', 'Two'))
    const { user, router } = renderApp('/')
    const mini = miniPlayer()
    // The library's like button loads just after the shell.
    await waitFor(() => expect(mini.getByRole('button', { name: 'Like' })).toBeEnabled())

    mini.getByRole('link', { name: /^Open now playing: One/ }).focus()
    for (const name of ['Like', 'Previous', 'Pause', 'Next']) {
      await user.tab()
      expect(mini.getByRole('button', { name })).toHaveFocus()
    }
    await user.keyboard('{Enter}')

    await waitFor(() => expect(player.getState().queue.index).toBe(1))
    expect(mini.getByRole('button', { name: 'Next' })).toHaveFocus()
    expect(destination(router)).toBe('/')
  })
})
