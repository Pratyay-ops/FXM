import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestPlayback } from '../now-playing/testing'
import { useSettingsStore } from '../settings/settings-store'
import { useSkipNoticeStore } from './skipping'
import { SKIP_NOTICE_MS } from './sponsorblock-notices'
import { SPONSORBLOCK_STORAGE_KEY, useSponsorBlockStore } from './sponsorblock-store'
import { setupTestSponsorBlock, testSegment, testVideo } from './testing'

const OFFER = 'Skip the non-music parts of videos?'
const offer = () => screen.queryByRole('region', { name: OFFER })
const stored = () => JSON.parse(localStorage.getItem(SPONSORBLOCK_STORAGE_KEY) ?? 'null')

afterEach(() => {
  vi.useRealTimers()
})

describe('SponsorBlock offer', () => {
  it('shows in Music + Video mode, and turns skipping on', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    const card = await screen.findByRole('region', { name: OFFER })
    expect(card).toHaveTextContent(/SponsorBlock’s community marks the intros/)
    expect(card).toHaveTextContent(/never tells SponsorBlock which video you play/)

    await user.click(within(card).getByRole('button', { name: 'Turn on' }))

    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState()).toMatchObject({ enabled: true, offered: true })
    expect(stored()).toMatchObject({ state: { enabled: true, offered: true } })
  })

  it('goes away for good with "Not now", and skipping stays off', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user, unmount } = renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'Not now' }))

    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState()).toMatchObject({ enabled: false, offered: true })
    unmount()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
  })

  it('waits for Music + Video mode, and stays off Settings, which has the switch', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()

    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(await screen.findByRole('region', { name: OFFER })).toBeInTheDocument()
  })

  it('stays off the Settings page', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    renderApp('/settings')
    expect(
      await screen.findByRole('switch', { name: 'Skip non-music parts of videos' }),
    ).toBeInTheDocument()
    expect(offer()).not.toBeInTheDocument()
  })

  it('stays away once skipping was set in Settings', async () => {
    useSponsorBlockStore.getState().setEnabled(false)
    useSettingsStore.getState().setCatalogMode('all')
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
  })

  it('hands keyboard focus to the page once answered', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    const notNow = await screen.findByRole('button', { name: 'Not now' })
    notNow.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('main')).toHaveFocus()
  })
})

describe('skip notice', () => {
  function playingVideo() {
    useSettingsStore.getState().setCatalogMode('all')
    useSponsorBlockStore.getState().setEnabled(true)
    setupTestSponsorBlock(() => [testSegment(0, 12)])
    return setupTestPlayback()
  }

  it('says what was skipped, and undoes it', async () => {
    const { player } = playingVideo()
    const { user } = renderApp('/')
    await player.setQueue([testVideo('fxmVideoAAA')])

    const status = screen.getByRole('status', { name: 'Skip notice' })
    await waitFor(() => expect(status).toHaveTextContent('Skipped a non-music part'))
    expect(status).toHaveTextContent('fxmVideoAAA (Official Video)')
    expect(player.getState().positionMs).toBe(12_000)

    await user.click(within(status).getByRole('button', { name: 'Undo' }))

    expect(player.getState().positionMs).toBe(0)
    expect(status).toBeEmptyDOMElement()
  })

  it('offers no undo once the track it was in has gone, and can be dismissed', async () => {
    const { player } = playingVideo()
    const { user } = renderApp('/')
    await player.setQueue([testVideo('fxmVideoAAA'), testVideo('fxmVideoBBB')])
    const status = screen.getByRole('status', { name: 'Skip notice' })
    await waitFor(() => expect(status).toHaveTextContent('fxmVideoAAA'))
    expect(within(status).getByRole('button', { name: 'Undo' })).toBeInTheDocument()

    act(() =>
      useSkipNoticeStore.setState({ notice: { id: 99, uid: 1234, title: 'Gone', toEnd: false } }),
    )
    expect(within(status).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()

    await user.click(within(status).getByRole('button', { name: 'Dismiss' }))
    expect(status).toBeEmptyDOMElement()
  })

  it('offers no undo for a skip that ended the track', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    act(() =>
      useSkipNoticeStore.setState({ notice: { id: 1, uid: 0, title: 'Outro', toEnd: true } }),
    )
    const status = screen.getByRole('status', { name: 'Skip notice' })
    expect(status).toHaveTextContent('Outro')
    expect(within(status).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('goes away by itself, but not while the pointer is on it', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    vi.useFakeTimers()
    act(() =>
      useSkipNoticeStore.setState({ notice: { id: 1, uid: 0, title: 'Intro', toEnd: false } }),
    )
    const status = screen.getByRole('status', { name: 'Skip notice' })
    const card = status.firstElementChild as HTMLElement

    act(() => card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS * 2))
    expect(status).toHaveTextContent('Intro')

    act(() => card.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS - 1))
    expect(status).toHaveTextContent('Intro')
    act(() => vi.advanceTimersByTime(1))
    expect(status).toBeEmptyDOMElement()
  })
})
