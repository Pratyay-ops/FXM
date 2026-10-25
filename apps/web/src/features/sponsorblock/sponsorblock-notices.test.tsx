import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestPlayback } from '../now-playing/testing'
import { useSettingsStore } from '../settings/settings-store'
import { type SkipNotice, useSkipNoticeStore } from './skipping'
import { PHONE_QUERY, SHORT_QUERY, SKIP_NOTICE_MS } from './sponsorblock-notices'
import {
  OFFER_SESSION_KEY,
  SPONSORBLOCK_STORAGE_KEY,
  useSponsorBlockStore,
} from './sponsorblock-store'
import { setupTestSponsorBlock, testSegment, testVideo } from './testing'

const OFFER = 'Skip non-music parts of videos?'
const offer = () => screen.queryByRole('region', { name: OFFER })
const stored = () => JSON.parse(localStorage.getItem(SPONSORBLOCK_STORAGE_KEY) ?? 'null')
/** What screen readers hear from SponsorBlock. */
const announcer = () => screen.getByRole('status', { name: 'SponsorBlock' })

/** Makes the window match only `queries`, e.g. a phone's. */
function matchOnly(...queries: string[]) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: queries.includes(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

/** Shows `notice` as if a skip had just happened. */
function showNotice(notice: Partial<SkipNotice> & Pick<SkipNotice, 'id'>) {
  act(() =>
    useSkipNoticeStore.setState({ notice: { uid: 0, title: 'Intro', part: 'intro', ...notice } }),
  )
}

/** The first link of the player bar: where focus comes from in these tests. */
function playerLink() {
  const [bar] = screen.getAllByRole('region', { name: 'Player' })
  return within(bar as HTMLElement).getAllByRole('link')[0] as HTMLElement
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SponsorBlock offer', () => {
  it('shows in Music + Video mode, turns skipping on and says so', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    const card = await screen.findByRole('region', { name: OFFER })
    expect(card).toHaveTextContent(/SponsorBlock’s community marks the intros/)
    expect(card).toHaveTextContent(/SponsorBlock never learns what you play/)

    await user.click(within(card).getByRole('button', { name: 'Turn on' }))

    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState()).toMatchObject({ enabled: true, offered: true })
    expect(stored()).toMatchObject({ state: { enabled: true, offered: true } })
    expect(announcer()).toHaveTextContent('Skipping is on. You can turn it off in Settings.')
  })

  it('goes away for good with "No thanks", says so, and skipping stays off', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user, unmount } = renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'No thanks' }))

    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState()).toMatchObject({ enabled: false, offered: true })
    expect(announcer()).toHaveTextContent('Skipping stays off. You can turn it on in Settings.')
    unmount()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
  })

  it('confirms the answer for a while, longer while the pointer is on it', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    await user.click(await screen.findByRole('button', { name: 'Turn on' }))
    const confirmation = screen.getByText('Skipping is on.').closest('div') as HTMLElement
    vi.useFakeTimers()

    act(() => confirmation.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS * 2))
    expect(confirmation).toBeInTheDocument()
    act(() => confirmation.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS))
    expect(confirmation).not.toBeInTheDocument()
    expect(announcer()).toBeEmptyDOMElement()
  })

  it('waits for Music + Video mode', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()

    act(() => useSettingsStore.getState().setCatalogMode('all'))
    expect(await screen.findByRole('region', { name: OFFER })).toBeInTheDocument()
  })

  it('stays off Settings, which has the switch, and Now playing, which has the controls', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { unmount } = renderApp('/settings')
    expect(
      await screen.findByRole('switch', { name: 'Skip non-music parts of videos' }),
    ).toBeInTheDocument()
    expect(offer()).not.toBeInTheDocument()
    unmount()

    renderApp('/now-playing')
    await screen.findByRole('heading', { level: 1, name: 'Now playing' })
    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState().offerShown).toBe(false)
  })

  it('stays away once skipping was set in Settings', async () => {
    useSponsorBlockStore.getState().setEnabled(false)
    useSettingsStore.getState().setCatalogMode('all')
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
  })

  it('shows in the first session that shows it only', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const first = renderApp('/')
    await screen.findByRole('region', { name: OFFER })
    expect(useSponsorBlockStore.getState().offerShown).toBe(true)
    expect(stored()).toMatchObject({ state: { offered: false, offerShown: true } })
    expect(sessionStorage.getItem(OFFER_SESSION_KEY)).toBe('1')
    first.unmount()

    // A reload in the same session: still there.
    const reload = renderApp('/')
    expect(await screen.findByRole('region', { name: OFFER })).toBeInTheDocument()
    reload.unmount()

    // Another session, say a new tab: Settings has the choice.
    sessionStorage.clear()
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
  })

  it('waits for a window tall enough to show it', async () => {
    matchOnly(SHORT_QUERY)
    useSettingsStore.getState().setCatalogMode('all')
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    expect(offer()).not.toBeInTheDocument()
    expect(useSponsorBlockStore.getState().offerShown).toBe(false)
  })

  it('hands keyboard focus to the page once answered', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    const noThanks = await screen.findByRole('button', { name: 'No thanks' })
    noThanks.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('hands keyboard focus back to where it came from once answered', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    const { user } = renderApp('/')
    await screen.findByRole('region', { name: OFFER })
    const link = playerLink()
    link.focus()
    // The cards come before the player bar.
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'No thanks' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(link).toHaveFocus()
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

    const card = await screen.findByRole('region', { name: 'Skipped the intro' })
    expect(card).toHaveTextContent('fxmVideoAAA (Official Video)')
    expect(announcer()).toHaveTextContent('Skipped the intro: fxmVideoAAA (Official Video).')
    expect(player.getState().positionMs).toBe(12_000)

    await user.click(within(card).getByRole('button', { name: 'Undo' }))

    expect(player.getState().positionMs).toBe(0)
    expect(card).not.toBeInTheDocument()
    expect(announcer()).toBeEmptyDOMElement()
  })

  it('names the part it skipped', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    showNotice({ id: 1, part: 'other' })
    expect(screen.getByRole('region', { name: 'Skipped a non-music part' })).toBeInTheDocument()
    showNotice({ id: 2, part: 'outro' })
    expect(screen.getByRole('region', { name: 'Skipped the outro' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Skipped a non-music part' })).toBeNull()
    expect(announcer()).toHaveTextContent('Skipped the outro: Intro.')
  })

  it('keeps Undo for as long as it works, and goes with the track', async () => {
    const { player } = playingVideo()
    setupTestSponsorBlock((videoId) => (videoId === 'fxmVideoAAA' ? [testSegment(0, 12)] : []))
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    vi.useFakeTimers()
    await act(() => player.setQueue([testVideo('fxmVideoAAA'), testVideo('fxmVideoBBB')]))
    await act(() => vi.advanceTimersByTimeAsync(0))
    const card = screen.getByRole('region', { name: 'Skipped the intro' })

    await act(() => vi.advanceTimersByTimeAsync(SKIP_NOTICE_MS * 4))
    expect(within(card).getByRole('button', { name: 'Undo' })).toBeInTheDocument()

    await act(() => player.next())
    expect(card).not.toBeInTheDocument()
  })

  it('offers no undo for an outro, and goes by itself, but not while the pointer or focus is on it', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    vi.useFakeTimers()
    showNotice({ id: 1, title: 'Outro', part: 'outro' })
    const card = screen.getByRole('region', { name: 'Skipped the outro' })
    expect(within(card).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    const dismiss = within(card).getByRole('button', { name: 'Dismiss' })

    // Focus on it, then the pointer passes over it: focus still holds the clock.
    act(() => dismiss.focus())
    act(() => card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => card.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS * 2))
    expect(card).toBeInTheDocument()

    // The pointer on it, then focus leaves: the pointer still holds it.
    act(() => card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => dismiss.blur())
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS * 2))
    expect(card).toBeInTheDocument()

    act(() => card.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS - 1))
    expect(card).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(card).not.toBeInTheDocument()
  })

  it('offers no undo once the track it was in has gone, and goes by itself', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    vi.useFakeTimers()
    showNotice({ id: 99, uid: 1234, title: 'Gone' })
    const card = screen.getByRole('region', { name: 'Skipped the intro' })
    expect(within(card).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(SKIP_NOTICE_MS))
    expect(card).not.toBeInTheDocument()
  })

  it('hands keyboard focus back to where it came from after Undo or Dismiss', async () => {
    const { player } = playingVideo()
    const { user } = renderApp('/')
    for (const action of ['Undo', 'Dismiss']) {
      await act(() => player.setQueue([testVideo('fxmVideoAAA')]))
      const card = await screen.findByRole('region', { name: 'Skipped the intro' })
      const link = playerLink()
      link.focus()
      // Shift+Tab from the player bar reaches Dismiss, then Undo.
      await user.tab({ shift: true })
      if (action === 'Undo') await user.tab({ shift: true })
      expect(within(card).getByRole('button', { name: action })).toHaveFocus()

      await user.keyboard('{Enter}')

      expect(card).not.toBeInTheDocument()
      expect(link).toHaveFocus()
    }
  })

  it('hands keyboard focus to the page when it came from nowhere', async () => {
    const { user } = renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    showNotice({ id: 1, part: 'outro' })
    within(screen.getByRole('region', { name: 'Skipped the outro' }))
      .getByRole('button', { name: 'Dismiss' })
      .focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('hands keyboard focus back when a newer skip replaces it', async () => {
    renderApp('/')
    await screen.findByRole('heading', { level: 1 })
    showNotice({ id: 1, part: 'outro' })
    const link = playerLink()
    link.focus()
    act(() => {
      within(screen.getByRole('region', { name: 'Skipped the outro' }))
        .getByRole('button', { name: 'Dismiss' })
        .focus()
    })

    showNotice({ id: 2, part: 'other' })

    expect(screen.getByRole('region', { name: 'Skipped a non-music part' })).toBeInTheDocument()
    expect(link).toHaveFocus()
  })

  it('shows under Now playing’s controls on phones, and above the bars elsewhere', async () => {
    matchOnly(PHONE_QUERY)
    const { router } = renderApp('/now-playing')
    const track = await screen.findByRole('region', { name: 'Track' })
    showNotice({ id: 1 })
    expect(within(track).getByRole('region', { name: 'Skipped the intro' })).toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: 'Skipped the intro' })).toHaveLength(1)

    await act(() => router.navigate('/'))
    await screen.findByRole('heading', { level: 1, name: /^Good/ })
    expect(screen.getAllByRole('region', { name: 'Skipped the intro' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Track' })).not.toBeInTheDocument()
  })

  it('shows above the bars on Now playing from 768 px, where the player bar has the controls', async () => {
    renderApp('/now-playing')
    const track = await screen.findByRole('region', { name: 'Track' })
    showNotice({ id: 1 })
    expect(screen.getByRole('region', { name: 'Skipped the intro' })).toBeInTheDocument()
    expect(within(track).queryByRole('region', { name: 'Skipped the intro' })).toBeNull()
  })
})
