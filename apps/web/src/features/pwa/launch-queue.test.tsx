import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { type LaunchParams, launchPath, launchQueue } from './launch-queue'

const ORIGIN = 'https://fxmusic.pages.dev'

describe('launchPath', () => {
  it.each([
    ['a shortcut', `${ORIGIN}/app/search`, '/search'],
    ['a deep link with a query and hash', `${ORIGIN}/app/search?q=lofi#top`, '/search?q=lofi#top'],
    ['the start URL with a query', `${ORIGIN}/app/?q=x`, '/?q=x'],
  ])('opens %s inside the app', (_name, url, path) => {
    expect(launchPath(url, '/app/', ORIGIN)).toBe(path)
  })

  it.each([
    ['a plain relaunch (the start URL)', `${ORIGIN}/app/`],
    ['the site outside the app', `${ORIGIN}/privacy`],
    ['the base without its slash', `${ORIGIN}/app`],
    ['another origin', 'https://example.com/app/search'],
    ['no URL', undefined],
    ['an unparsable URL', 'not a url'],
  ])('stays put for %s', (_name, url) => {
    expect(launchPath(url, '/app/', ORIGIN)).toBeUndefined()
  })
})

/** Chromium's `window.launchQueue`, delivering launches like the browser would. */
function fakeLaunchQueue() {
  let consumer: ((params: LaunchParams) => void) | undefined
  const queue = { setConsumer: (next: (params: LaunchParams) => void) => (consumer = next) }
  Object.defineProperty(window, 'launchQueue', { value: queue, configurable: true })
  return {
    launch(path: string) {
      const url = new URL(`${import.meta.env.BASE_URL}${path}`, window.location.origin)
      act(() => consumer?.({ targetURL: url.href }))
    },
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'launchQueue')
})

describe('launches of the open app', () => {
  it('has no launch queue outside Chromium', () => {
    expect(launchQueue()).toBeUndefined()
  })

  it('opens the page a shortcut asks for, without reloading', async () => {
    const queue = fakeLaunchQueue()
    const { router } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })

    queue.launch('library')

    expect(await screen.findByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/library')
  })

  it('only focuses the window for a plain relaunch', async () => {
    const queue = fakeLaunchQueue()
    const { router } = renderApp('/settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    const { key } = router.state.location

    queue.launch('')

    expect(router.state.location.key).toBe(key)
  })

  it('adds no history entry when the launch asks for the page already open', async () => {
    const queue = fakeLaunchQueue()
    const { router } = renderApp('/search')
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    const { key } = router.state.location

    queue.launch('search')

    expect(router.state.location.key).toBe(key)
  })
})
