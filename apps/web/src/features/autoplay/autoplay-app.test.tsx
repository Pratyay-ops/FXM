import type { QueueItem, Track } from '@fxm/core'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { homeSourcesUntil } from '../../app/services/home'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'
import { appHomeServices } from '../home/services'
import { fakeRecommendations, homeServices, song } from '../home/testing'
import { setupTestPlayback } from '../now-playing/testing'
import { playbackFromPlayer } from '../search/actions'
import { renderCatalog } from '../search/testing'
import { AUTOPLAY_SETTLE_MS } from './autoplay'
import { AUTOPLAY_TITLE } from './autoplay-marks'
import { AUTOPLAY_FINDING, AUTOPLAY_HELP, AUTOPLAY_NEEDS_YOUTUBE } from './autoplay-setting'
import { AUTOPLAY_STORAGE_KEY, useAutoplayStore } from './autoplay-store'

const MINUTE = 60_000

/** How long autoplay may take to add songs: it waits for the queue to settle first. */
const ADDING = { timeout: AUTOPLAY_SETTLE_MS + 5_000 }

const nightSwim = song('ns1', 'Night Swim', 'Juniper Coast')
const lowTide = song('lt1', 'Low Tide', 'Dune Theory')
const lowTideRadio = [
  song('ir1', 'Iris Song', 'Iris Vale'),
  song('lk1', 'Lark Song', 'Lark Avenue'),
  song('mr1', 'Mirror Song', 'Mirror Lake'),
  song('nf1', 'Fern Song', 'Northern Fern'),
]
const elsewhere = [song('or1', 'Orchid Song', 'Orchid Static')]

const titles = (items: readonly { track: Track }[]) => items.map((item) => item.track.title)
const upNext = (items: readonly QueueItem[], index: number) => titles(items.slice(index + 1))

const wired = appHomeServices.get()

afterEach(() => {
  appHomeServices.set(wired)
})

/** The app's services in the Full tier, with radios for Low Tide and anything else. */
function wireFullTier() {
  const recommendations = fakeRecommendations({
    radio: { 'Low Tide': lowTideRadio, '*': elsewhere },
  })
  appHomeServices.set(homeServices('full', { recommendations }))
  return recommendations
}

/** Low Tide, heard through a few minutes ago: the heaviest seed of the radio. */
async function heardLowTide() {
  await getLibrary().recordPlay({
    track: lowTide,
    playedAt: Date.now() - 4 * MINUTE,
    playedMs: 200_000,
    durationMs: 200_000,
    completed: true,
    skipped: false,
  })
}

/** Waits until the queue holds `count` items: autoplay waits for the queue to settle first. */
async function queueOf(
  player: { getState(): { queue: { items: readonly QueueItem[] } } },
  count: number,
) {
  await vi.waitFor(() => expect(player.getState().queue.items).toHaveLength(count), ADDING)
}

/** The queue panel's "Next up", once it shows. */
async function nextUpRegion() {
  return screen.findByRole('region', { name: 'Next up' })
}

describe('autoplay in the app', () => {
  it('keeps the queue going from the last plays, marks its songs, and takes them out when off', async () => {
    await heardLowTide()
    const recommendations = wireFullTier()
    const { player } = setupTestPlayback()

    await player.setQueue([nightSwim])
    await queueOf(player, 5)

    // Low Tide, heard through, seeded the radio it fetched: one radio fetch, at prefetch.
    expect(recommendations.calls.map((call) => call.parts)).toEqual([['radio']])
    expect(upNext(player.getState().queue.items, 0)).toEqual(
      titles(lowTideRadio.map((track) => ({ track }))),
    )

    const { user } = renderApp('/now-playing?tab=queue')
    const next = await nextUpRegion()
    const rows = within(next).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(within(row).getByText('Autoplay')).toBeInTheDocument()
    const now = screen.getByRole('region', { name: 'Now playing' })
    expect(within(now).queryByText('Autoplay')).not.toBeInTheDocument()
    // It added them before the panel showed: nothing was announced.
    expect(screen.queryByText(/^Autoplay added/)).not.toBeInTheDocument()

    const toggle = within(next).getByRole('switch', { name: 'Autoplay' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/songs like the ones you just played/)
    await user.click(toggle)

    expect(useAutoplayStore.getState().enabled).toBe(false)
    expect(titles(player.getState().queue.items)).toEqual(['Night Swim'])
    expect(within(next).queryAllByRole('listitem')).toEqual([])
    expect(
      screen.getByText('Autoplay is off. It took out the 4 songs it added.'),
    ).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(AUTOPLAY_STORAGE_KEY) ?? 'null')).toMatchObject({
      state: { enabled: false },
    })
  })

  it('says it is finding songs and which it added, and plays what the user adds first', async () => {
    await heardLowTide()
    wireFullTier()
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim])

    renderApp('/now-playing?tab=queue')
    const next = await nextUpRegion()
    // The queue is low: no "Nothing up next", autoplay is on it.
    expect(within(next).getByText(AUTOPLAY_FINDING)).toBeInTheDocument()
    expect(
      await screen.findByText(/^Autoplay added 4 songs, starting with /, {}, ADDING),
    ).toBeInTheDocument()
    expect(within(next).getAllByRole('listitem')).toHaveLength(4)
    expect(within(next).queryByText(AUTOPLAY_FINDING)).not.toBeInTheDocument()

    // "Add to queue": the song plays next, before the songs autoplay added.
    const mine = song('my1', 'My Song', 'Paper Kites Club')
    await act(async () => playbackFromPlayer(player).addToQueue([mine]))
    expect(upNext(player.getState().queue.items, 0)).toEqual([
      'My Song',
      ...titles(lowTideRadio.map((track) => ({ track }))),
    ])
    const [first] = within(next).getAllByRole('listitem')
    expect(first).toHaveTextContent('My Song')
    expect(within(first as HTMLElement).queryByText('Autoplay')).not.toBeInTheDocument()
  })

  it('finds other songs after the user clears the ones up next, and says so', async () => {
    await heardLowTide()
    wireFullTier()
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim])
    await queueOf(player, 5)
    const { user } = renderApp('/now-playing?tab=queue')
    const next = await nextUpRegion()

    await user.click(within(next).getByRole('button', { name: 'Clear the songs up next' }))

    expect(screen.getByText('Cleared the songs up next.')).toBeInTheDocument()
    expect(within(next).getByText(AUTOPLAY_FINDING)).toBeInTheDocument()
    // Not the ones the user cleared.
    expect(await screen.findByText('Autoplay added Orchid Song.', {}, ADDING)).toBeInTheDocument()
    expect(upNext(player.getState().queue.items, 0)).toEqual(['Orchid Song'])
  })

  it('leaves a song it added in the queue once the user moves it', async () => {
    await heardLowTide()
    wireFullTier()
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim])
    await queueOf(player, 5)
    const { user } = renderApp('/now-playing?tab=queue')
    const next = await nextUpRegion()

    await user.click(within(next).getByRole('button', { name: 'Move Mirror Song' }))
    const moves = within(screen.getByRole('group', { name: 'Move Mirror Song' }))
    await user.click(moves.getByRole('button', { name: 'Play next' }))
    const [first] = within(next).getAllByRole('listitem')
    expect(first).toHaveTextContent('Mirror Song')
    expect(within(first as HTMLElement).queryByText('Autoplay')).not.toBeInTheDocument()

    await user.click(within(next).getByRole('switch', { name: 'Autoplay' }))

    expect(titles(player.getState().queue.items)).toEqual(['Night Swim', 'Mirror Song'])
    expect(
      screen.getByText('Autoplay is off. It took out the 3 songs it added.'),
    ).toBeInTheDocument()
  })

  it('marks the song playing when autoplay added it, and plays from its radio', async () => {
    wireFullTier()
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim])
    await queueOf(player, 2)
    await player.next()

    renderApp('/now-playing?tab=queue')
    const now = await screen.findByRole('region', { name: 'Now playing' })
    expect(within(now).getByText('Orchid Song')).toBeInTheDocument()
    expect(within(now).getByText('Autoplay')).toBeInTheDocument()
    const next = screen.getByRole('region', { name: 'Next up' })
    expect(within(next).getByText(/^Playing from/)).toHaveTextContent('Playing from Autoplay')
  })

  it('records a play of a song autoplay added as a play of its radio', async () => {
    // The clock moves with the music, so the play counts as heard through.
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    wireFullTier()
    const { player, engine } = setupTestPlayback({ recordPlays: true })
    await player.setQueue([nightSwim])
    await queueOf(player, 2)
    await player.next()
    expect(titles(player.getState().queue.items)[1]).toBe('Orchid Song')

    for (let ms = 0; ms < 200_000; ms += 1_000) {
      clock += 1_000
      engine.progress(engine.positionMs + 1_000)
    }
    act(() => engine.end())

    await vi.waitFor(async () => expect(await getLibrary().history()).toHaveLength(1))
    const [record] = await getLibrary().history()
    expect(record?.trackId).toBe(elsewhere[0]?.id)
    expect(record?.context).toMatchObject({
      type: 'radio',
      seed: nightSwim.id,
      title: AUTOPLAY_TITLE,
    })
  })

  it('stays out of the way in the Free tier', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim, lowTide])
    await new Promise((resolve) => setTimeout(resolve, AUTOPLAY_SETTLE_MS + 200))
    expect(player.getState().queue.items).toHaveLength(2)

    renderApp('/now-playing?tab=queue')
    const next = await nextUpRegion()
    expect(within(next).getAllByRole('listitem')).toHaveLength(1)
    expect(within(next).queryByRole('switch', { name: 'Autoplay' })).not.toBeInTheDocument()
    expect(within(next).queryByText(AUTOPLAY_FINDING)).not.toBeInTheDocument()
  })
})

describe('autoplay in Settings', () => {
  it.each(['free', 'lite', 'full'] as const)(
    'says only what it does until the recommendation sources are wired in, in the %s tier',
    async (tier) => {
      const { user } = renderCatalog('/settings', { tier })
      const toggle = await screen.findByRole('switch', { name: 'Autoplay' })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
      // The app wires them in once the platform is ready: until then the tier isn't known.
      expect(toggle).toHaveAccessibleDescription(AUTOPLAY_HELP)
      expect(screen.queryByText(AUTOPLAY_NEEDS_YOUTUBE)).not.toBeInTheDocument()
      await user.click(toggle)
      expect(useAutoplayStore.getState().enabled).toBe(false)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    },
  )

  it.each([
    ['free', true],
    ['lite', false],
    ['full', false],
  ] as const)('says what it needs, in the %s tier', async (tier, needs) => {
    const { sources } = renderCatalog('/settings', { tier })
    act(() => appHomeServices.set({ sources, recommendations: fakeRecommendations() }))
    const toggle = await screen.findByRole('switch', { name: 'Autoplay' })
    expect(screen.queryByText(AUTOPLAY_NEEDS_YOUTUBE) !== null).toBe(needs)
    const guides = screen.queryByRole('link', { name: 'Tiers and install guides' })
    expect(guides !== null).toBe(needs)
    if (needs) {
      expect(guides).toHaveAttribute('href', '/connect')
      expect(toggle).toHaveAccessibleDescription(/Autoplay needs YouTube Music/)
    }
  })

  it('waits for FXM Connect to answer before it says what autoplay needs', async () => {
    const { sources } = renderCatalog('/settings', { tier: 'free' })
    act(() => {
      sources.setDetecting(true)
      appHomeServices.set({ sources, recommendations: fakeRecommendations() })
    })
    await screen.findByRole('switch', { name: 'Autoplay' })
    expect(screen.queryByText(AUTOPLAY_NEEDS_YOUTUBE)).not.toBeInTheDocument()
    act(() => sources.setDetecting(false))
    await waitFor(() => expect(screen.getByText(AUTOPLAY_NEEDS_YOUTUBE)).toBeInTheDocument())
  })

  it('waits for the app to know the tier, as Home’s sources say, before it says what autoplay needs', async () => {
    const { sources } = renderCatalog('/settings', { tier: 'free' })
    let known: () => void = () => {}
    // The composition root's view of the registry: the tier unknown until the platform's first
    // detection ended, the first Lite self-test included, which the registry doesn't wait for.
    const home = homeSourcesUntil(
      sources,
      new Promise<void>((resolve) => {
        known = resolve
      }),
    )
    act(() => appHomeServices.set({ sources: home, recommendations: fakeRecommendations() }))
    await screen.findByRole('switch', { name: 'Autoplay' })
    expect(sources.getSnapshot().detecting).not.toBe(true)
    expect(screen.queryByText(AUTOPLAY_NEEDS_YOUTUBE)).not.toBeInTheDocument()
    act(() => known())
    await waitFor(() => expect(screen.getByText(AUTOPLAY_NEEDS_YOUTUBE)).toBeInTheDocument())
  })
})
