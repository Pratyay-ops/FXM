import { testTracks } from '@fxm/player/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestLyrics, setupTestPlayback } from '../now-playing/testing'

// Both bars render; CSS shows the player bar from 768px and the mini player below.
const bars = () => screen.getAllByRole('region', { name: 'Player' })
/** The mini player, which comes after the player bar. */
const miniPlayer = () => within(bars()[1] as HTMLElement)

/** Where the app is going: the page it shows, or the one a navigation is still loading. */
function destination(router: ReturnType<typeof renderApp>['router']): string {
  return (router.state.navigation.location ?? router.state.location).pathname
}

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
