import type { QueueItem, Track } from '@fxm/core'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'
import { appHomeServices } from '../home/services'
import { fakeRecommendations, homeServices, song } from '../home/testing'
import { setupTestPlayback } from '../now-playing/testing'
import { renderCatalog } from '../search/testing'
import { AUTOPLAY_SETTLE_MS } from './autoplay'
import { AUTOPLAY_TITLE } from './autoplay-marks'
import { AUTOPLAY_NEEDS_YOUTUBE } from './autoplay-setting'
import { AUTOPLAY_STORAGE_KEY, useAutoplayStore } from './autoplay-store'

const MINUTE = 60_000

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

/** Waits until the queue holds `count` items: autoplay waits for the queue to settle first. */
async function queueOf(
  player: { getState(): { queue: { items: readonly QueueItem[] } } },
  count: number,
) {
  await vi.waitFor(() => expect(player.getState().queue.items).toHaveLength(count), {
    timeout: AUTOPLAY_SETTLE_MS + 5_000,
  })
}

describe('autoplay in the app', () => {
  it('keeps the queue going from the last plays, marks its songs, and takes them out when off', async () => {
    await getLibrary().recordPlay({
      track: lowTide,
      playedAt: Date.now() - 4 * MINUTE,
      playedMs: 200_000,
      durationMs: 200_000,
      completed: true,
      skipped: false,
    })
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
    const next = await screen.findByRole('region', { name: 'Next up' })
    const rows = within(next).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(within(row).getByText('Autoplay')).toBeInTheDocument()
    const now = screen.getByRole('region', { name: 'Now playing' })
    expect(within(now).queryByText('Autoplay')).not.toBeInTheDocument()

    const toggle = within(next).getByRole('switch', { name: 'Autoplay' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/songs like the ones you just played/)
    await user.click(toggle)

    expect(useAutoplayStore.getState().enabled).toBe(false)
    expect(titles(player.getState().queue.items)).toEqual(['Night Swim'])
    expect(within(next).queryAllByRole('listitem')).toEqual([])
    expect(JSON.parse(localStorage.getItem(AUTOPLAY_STORAGE_KEY) ?? 'null')).toMatchObject({
      state: { enabled: false },
    })
  })

  it('marks the song playing when autoplay added it', async () => {
    wireFullTier()
    const { player } = setupTestPlayback()
    await player.setQueue([nightSwim])
    await queueOf(player, 2)
    await player.next()

    renderApp('/now-playing?tab=queue')
    const now = await screen.findByRole('region', { name: 'Now playing' })
    expect(within(now).getByText('Orchid Song')).toBeInTheDocument()
    expect(within(now).getByText('Autoplay')).toBeInTheDocument()
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
    const next = await screen.findByRole('region', { name: 'Next up' })
    expect(within(next).getAllByRole('listitem')).toHaveLength(1)
    expect(within(next).queryByRole('switch', { name: 'Autoplay' })).not.toBeInTheDocument()
  })

  it.each([
    ['free', true],
    ['lite', false],
    ['full', false],
  ] as const)('says in Settings what it needs, in the %s tier', async (tier, needs) => {
    const { user } = renderCatalog('/settings', { tier })
    const toggle = await screen.findByRole('switch', { name: 'Autoplay' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(/songs like the ones you just played/)
    expect(screen.queryByText(AUTOPLAY_NEEDS_YOUTUBE) !== null).toBe(needs)
    await user.click(toggle)
    expect(useAutoplayStore.getState().enabled).toBe(false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})
