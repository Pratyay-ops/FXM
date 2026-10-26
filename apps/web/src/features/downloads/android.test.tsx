import { formatId, type Track } from '@fxm/core'
import { downloadId, newDownloadRecord } from '@fxm/downloads'
import { FAKE_DOWNLOADS_FOLDER } from '@fxm/downloads/testing'
import { renderHook, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { track } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { useFeedbackStore } from '../search/feedback'
import { downloadTracks, NOTIFICATIONS_ASKED_KEY, saveDownloadToMusic } from './actions'
import { useSaveToMusicMenuItem } from './menu'
import { getDownloads, getOfflineStore, startDownloads } from './runtime'
import { fakeMediaUrl, setupDownloads } from './testing'

const main = () => within(screen.getByRole('main'))
const feedback = () => useFeedbackStore.getState().message

/** Waits until `song`'s download is done. */
async function completed(song: Track) {
  await vi.waitFor(async () =>
    expect((await getDownloads().manager.get(song))?.status).toBe('completed'),
  )
}

describe('downloads in the Android app', () => {
  it('go to the app’s own storage and play offline from there', async () => {
    const { plugin, downloads } = await setupDownloads({ android: true })
    expect(downloads.plugin).toBe(plugin)
    await downloads.manager.enqueue(track(1))
    await completed(track(1))
    const record = await downloads.manager.get(track(1))
    expect(plugin?.files.get(record?.file ?? '')).toHaveLength(3000)
    const stream = await getOfflineStore().find(track(1), downloads.environment.context())
    expect(stream?.url).toBe(
      `${window.location.origin}/_capacitor_file_${FAKE_DOWNLOADS_FOLDER}/${record?.file}`,
    )
  })

  it('keep the app running in the background while they download', async () => {
    const { plugin, downloads, server } = await setupDownloads({ android: true })
    // Held halfway, so the report of a running download can't be folded into the next one.
    server.rule(fakeMediaUrl(track(1), 1), { holdAt: 1500 })
    await downloads.manager.enqueue(track(1))
    await vi.waitFor(() =>
      expect(plugin?.reports).toContainEqual({
        downloading: 1,
        queued: 0,
        online: true,
        title: 'Song 1',
      }),
    )
    server.release(fakeMediaUrl(track(1), 1))
    await completed(track(1))
    await vi.waitFor(() =>
      expect(plugin?.reports.at(-1)).toEqual({ downloading: 0, queued: 0, online: true }),
    )
  })

  it('ask once, from the first download, to show their notification', async () => {
    const { plugin } = await setupDownloads({ android: true })
    const ask = vi.spyOn(
      plugin ?? { requestNotifications: async () => ({}) },
      'requestNotifications',
    )
    await downloadTracks([track(1)])
    await downloadTracks([track(2)])
    expect(ask).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(NOTIFICATIONS_ASKED_KEY)).toBe('1')
  })

  it('save a finished song to the Music folder', async () => {
    const { plugin, downloads } = await setupDownloads({ android: true })
    await downloads.manager.enqueue(track(1))
    await completed(track(1))
    await saveDownloadToMusic(track(1))
    expect(plugin?.exports[0]).toMatchObject({ title: 'Song 1', media: 'audio' })
    expect(feedback()).toBe(`Saved “Song 1” to ${plugin?.exports[0]?.path}`)
    await saveDownloadToMusic(track(2))
    expect(feedback()).toBe('“Song 2” isn’t downloaded on this device')
    plugin?.failNext('exportToMusic', 'NO_SPACE')
    await saveDownloadToMusic(track(1))
    expect(feedback()).toBe('There is no room left on this device')
  })

  it('offer “Save to Music folder” for finished downloads only', async () => {
    const { downloads } = await setupDownloads({ android: true, run: false })
    const done = { ...newDownloadRecord(track(1), 1), status: 'completed' as const, file: 'a' }
    await downloads.store.update(done.id, () => done)
    const queued = newDownloadRecord(track(2), 2)
    await downloads.store.update(queued.id, () => queued)
    const { result } = renderHook(() => useSaveToMusicMenuItem())
    await waitFor(() =>
      expect(result.current({ id: track(1).id, track: track(1) })).toMatchObject({
        id: 'save-to-music',
        label: 'Save to Music folder',
      }),
    )
    expect(result.current({ id: track(2).id, track: track(2) })).toBeUndefined()
    expect(result.current({ id: formatId('ytm', 'track', 'none') })).toBeUndefined()
    expect(downloadId(track(1))).toBe(done.id)
  })

  it('show the room on the device, and that FXM keeps them', async () => {
    const { plugin, downloads } = await setupDownloads({ android: true })
    if (plugin !== undefined) plugin.freeBytes = 2_000_000_000
    await downloads.manager.enqueue(track(1))
    await completed(track(1))
    renderApp('/library?tab=downloads')
    expect(await main().findByText('2.0 GB free for downloads')).toBeInTheDocument()
    expect(main().getByText(/FXM keeps these downloads until you remove them/)).toBeInTheDocument()
    expect(main().queryByText(/Your browser/)).toBeNull()
    expect(main().queryByRole('button', { name: 'Keep my downloads' })).toBeNull()
  })
})

describe('downloads in a browser', () => {
  it('neither ask for notifications nor offer the Music folder', async () => {
    await setupDownloads()
    expect(getDownloads().plugin).toBeUndefined()
    await downloadTracks([track(1)])
    expect(localStorage.getItem(NOTIFICATIONS_ASKED_KEY)).toBeNull()
    const { result } = renderHook(() => useSaveToMusicMenuItem())
    await completed(track(1))
    expect(result.current({ id: track(1).id, track: track(1) })).toBeUndefined()
    // Starting twice keeps one runner.
    expect(startDownloads()).toBe(startDownloads())
  })
})
