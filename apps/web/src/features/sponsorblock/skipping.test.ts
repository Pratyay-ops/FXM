import { testTrack } from '@fxm/player/testing'
import { waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resetPlayback } from '../now-playing/playback'
import { setupTestPlayback } from '../now-playing/testing'
import { useSettingsStore } from '../settings/settings-store'
import { undoLastSkip, useSkipNoticeStore } from './skipping'
import { segmentsFor, sponsorBlockContext } from './sponsorblock-source'
import { useSponsorBlockStore } from './sponsorblock-store'
import { setupTestSponsorBlock, testSegment, testVideo } from './testing'

/** Music + Video mode with skipping on, the app's playback on fakes, and a fake SponsorBlock. */
function setup(handler = () => [testSegment(0, 12)]) {
  useSettingsStore.getState().setCatalogMode('all')
  useSponsorBlockStore.getState().setEnabled(true)
  const sponsorBlock = setupTestSponsorBlock(handler)
  const playback = setupTestPlayback()
  return { sponsorBlock, ...playback }
}

const position = (player: { getState(): { positionMs: number } }) => player.getState().positionMs

describe('SponsorBlock skipping', () => {
  it('skips the intro of a video in Music + Video mode, asking only by videoId', async () => {
    const { sponsorBlock, player } = setup()

    await player.setQueue([testVideo('fxmVideoAAA')])

    await waitFor(() => expect(position(player)).toBe(12_000))
    expect(sponsorBlock.lookups).toEqual(['fxmVideoAAA'])
    expect(sponsorBlock.contexts[0]?.mode).toBe('all')
    expect(useSkipNoticeStore.getState().notice).toMatchObject({
      title: 'fxmVideoAAA (Official Video)',
      toEnd: false,
    })
  })

  it('asks nothing while skipping is off', async () => {
    const { sponsorBlock, player, engine } = setup()
    useSponsorBlockStore.getState().setEnabled(false)
    await player.setQueue([testVideo('fxmVideoAAA')])
    engine.progress(1000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sponsorBlock.lookups).toEqual([])
    expect(position(player)).toBe(1000)
  })

  it('asks nothing in Music mode, nor for songs', async () => {
    const { sponsorBlock, player, engine } = setup()
    useSettingsStore.getState().setCatalogMode('music')
    await player.setQueue([testVideo('fxmVideoAAA'), testTrack('fxmSong0001')])
    engine.progress(1000)
    await player.setQueue([testTrack('fxmSong0002')])
    // Music + Video asks again for what plays: a song, which is never asked about.
    useSettingsStore.getState().setCatalogMode('all')
    engine.progress(1000)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(sponsorBlock.lookups).toEqual([])
    expect(useSkipNoticeStore.getState().notice).toBeUndefined()
  })

  it('asks at once when skipping is turned on while a video plays', async () => {
    const { sponsorBlock, player, engine } = setup(() => [testSegment(30, 40)])
    useSponsorBlockStore.getState().setEnabled(false)
    await player.setQueue([testVideo('fxmVideoAAA')])
    engine.progress(31_000)

    useSponsorBlockStore.getState().setEnabled(true)

    await waitFor(() => expect(position(player)).toBe(40_000))
    expect(sponsorBlock.lookups).toEqual(['fxmVideoAAA'])
  })

  it('stops skipping in Music mode, and when turned off', async () => {
    const { sponsorBlock, player, engine } = setup(() => [testSegment(30, 40), testSegment(60, 70)])
    await player.setQueue([testVideo('fxmVideoAAA')])
    await waitFor(() => expect(sponsorBlock.lookups).toHaveLength(1))

    useSettingsStore.getState().setCatalogMode('music')
    engine.progress(31_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(position(player)).toBe(31_000)

    useSettingsStore.getState().setCatalogMode('all')
    await waitFor(() => expect(position(player)).toBe(40_000))
    expect(useSkipNoticeStore.getState().notice).toBeDefined()

    useSponsorBlockStore.getState().setEnabled(false)
    expect(useSkipNoticeStore.getState().notice).toBeUndefined()
    engine.progress(61_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(position(player)).toBe(61_000)
  })

  it('goes back on undo, once, and closes the notice', async () => {
    const { player, engine } = setup(() => [testSegment(30, 40)])
    await player.setQueue([testVideo('fxmVideoAAA')])
    await waitFor(() => expect(player.getState().status).toBe('playing'))
    engine.progress(30_500)
    await waitFor(() => expect(position(player)).toBe(40_000))

    expect(undoLastSkip()).toBe(true)
    expect(position(player)).toBe(30_500)
    expect(useSkipNoticeStore.getState().notice).toBeUndefined()
    expect(undoLastSkip()).toBe(false)
  })

  it('ignores segments marked on another cut of the video', async () => {
    const { sponsorBlock, player } = setup(() => [
      { startMs: 0, endMs: 12_000, videoDurationMs: 240_000 },
    ])
    await player.setQueue([testVideo('fxmVideoAAA')])
    await waitFor(() => expect(sponsorBlock.lookups).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(position(player)).toBe(0)
  })

  it('says nothing more once the playback is gone', async () => {
    const { player } = setup()
    await player.setQueue([testVideo('fxmVideoAAA')])
    await waitFor(() => expect(useSkipNoticeStore.getState().notice).toBeDefined())
    resetPlayback()
    expect(useSkipNoticeStore.getState().notice).toBeUndefined()
    expect(undoLastSkip()).toBe(false)
  })
})

describe('segmentsFor', () => {
  it('passes on the segments, with the duration they were marked on', async () => {
    useSettingsStore.getState().setCatalogMode('all')
    useSponsorBlockStore.getState().setEnabled(true)
    setupTestSponsorBlock(() => [testSegment(0, 12), { startMs: 50_000, endMs: 60_000 }])
    const item = { uid: 1, track: testVideo('fxmVideoAAA') }
    expect(await segmentsFor(item, new AbortController().signal)).toEqual([
      { startMs: 0, endMs: 12_000, mediaDurationMs: 180_000 },
      { startMs: 50_000, endMs: 60_000 },
    ])
  })

  it('looks up through the page fetch, without cookies', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    const controller = new AbortController()
    const ctx = sponsorBlockContext('all', controller.signal)
    await ctx.fetch('https://sponsor.ajay.app/api/skipSegments/6db9', { method: 'GET' })
    expect(spy).toHaveBeenCalledWith('https://sponsor.ajay.app/api/skipSegments/6db9', {
      method: 'GET',
      credentials: 'omit',
    })
    expect(ctx).toMatchObject({ platform: 'web', mode: 'all', signal: controller.signal })
  })
})
