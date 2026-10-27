import type { SaveRequest } from '@fxm/convert'
import { createInProcessConverter } from '@fxm/convert/testing'
import { FxmError, formatId, type Track } from '@fxm/core'
import { createMemoryDownloadStorage, downloadId, newDownloadRecord } from '@fxm/downloads'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { track } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { asBrowser, USER_AGENTS } from '../connect/testing'
import { playlistPath } from '../library/paths'
import { setLyricsProvider } from '../lyrics/lyrics-source'
import { useQualityStore } from '../settings/quality-store'
import { createPendingEnvironment } from './environment'
import { ERROR_TEXT } from './format'
import { getDownloads, resetDownloads } from './runtime'
import { setConverter, setDeviceSaver } from './save/save'
import { fakeMediaUrl, setupDownloads } from './testing'

const main = () => within(screen.getByRole('main'))

/** happy-dom has no `navigator.storage`: give it one for a test. */
function stubStorage(storage: Partial<StorageManager>) {
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true })
}

afterEach(() => {
  delete (navigator as { storage?: unknown }).storage
})

async function openRowMenu(user: ReturnType<typeof renderApp>['user'], title: string) {
  await user.click(await main().findByRole('button', { name: `More options for ${title}` }))
  return screen.findByRole('menu')
}

/** A completed download of `song`, put straight into the store. */
async function storeCompleted(downloads: ReturnType<typeof getDownloads>, song: Track) {
  const record = {
    ...newDownloadRecord(song, 1),
    status: 'completed' as const,
    file: 'kept',
    bytesDone: 3,
    bytesTotal: 3,
  }
  await downloads.store.update(record.id, () => record)
}

/**
 * Waits until the list's menus know the downloads: the menu of `control`, a song with a
 * completed download, offers "Remove download". Then closes it.
 */
async function waitForStatuses(user: ReturnType<typeof renderApp>['user'], control: string) {
  const menu = await openRowMenu(user, control)
  await within(menu).findByRole('menuitem', { name: 'Remove download' })
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

describe('the Downloads tab', { timeout: 30_000 }, () => {
  it("shows a download's progress, pauses and resumes it, and lists it once done", async () => {
    const { downloads, server } = await setupDownloads()
    server.rule(fakeMediaUrl(track(1), 1), { holdAt: 1500 })
    stubStorage({
      estimate: async () => ({ usage: 50_000, quota: 2_000_000_000 }),
      persisted: async () => true,
    })
    await downloads.manager.enqueue(track(1))
    const { user } = renderApp('/library?tab=downloads')
    const list = await main().findByRole('list', { name: 'Downloads on their way' })
    expect(await within(list).findByText('Song 1')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(list).getByRole('progressbar', { name: 'Download of Song 1' })).toHaveAttribute(
        'aria-valuenow',
        '34',
      ),
    )
    await user.click(within(list).getByRole('button', { name: 'Pause downloading Song 1' }))
    const resume = await within(list).findByRole('button', { name: 'Resume downloading Song 1' })
    // Every byte that arrived before the pause is kept: 1,500 of them.
    expect(await within(list).findByText(/Paused · 1\.5 KB of 3\.0 KB/)).toBeInTheDocument()
    await user.click(resume)
    const songs = await main().findByRole('list', { name: 'Songs in Downloads' })
    expect(await within(songs).findByText('Song 1')).toBeInTheDocument()
    await waitFor(() =>
      expect(main().queryByRole('list', { name: 'Downloads on their way' })).toBeNull(),
    )
    expect(main().getByRole('heading', { name: 'On this device' })).toBeInTheDocument()
    expect(main().getByText('1 song ready offline')).toBeInTheDocument()
    expect(main().getByRole('meter', { name: 'Storage the downloads use' })).toHaveAttribute(
      'aria-valuetext',
      '3.0 KB of 2.0 GB',
    )
    expect(main().getByText(/keeps these downloads/)).toBeInTheDocument()
  })

  it('asks the browser to keep the downloads', async () => {
    const { downloads } = await setupDownloads()
    const persist = vi.fn(async () => false)
    stubStorage({ persisted: async () => false, persist })
    await downloads.manager.enqueue(track(1))
    const { user } = renderApp('/library?tab=downloads')
    await user.click(await main().findByRole('button', { name: 'Keep my downloads' }))
    expect(persist).toHaveBeenCalled()
    expect(await main().findByText(/didn’t agree to keep them/)).toBeInTheDocument()
    expect(main().queryByRole('button', { name: 'Keep my downloads' })).toBeNull()
  })

  it('deletes a download from its menu, which takes it out of Downloads', async () => {
    const { downloads, storage } = await setupDownloads()
    await downloads.manager.enqueue(track(1))
    const { user } = renderApp('/library?tab=downloads')
    const songs = await main().findByRole('list', { name: 'Songs in Downloads' })
    await within(songs).findByText('Song 1')
    const menu = await openRowMenu(user, 'Song 1')
    expect(within(menu).queryByRole('menuitem', { name: 'Remove from this playlist' })).toBeNull()
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove download' }))
    expect(await main().findByRole('heading', { name: 'No downloads yet' })).toBeInTheDocument()
    await waitFor(async () => expect(await storage.list()).toEqual([]))
    expect(await screen.findByText('Removed the download of “Song 1”')).toBeInTheDocument()
  })

  it('cancels a download on its way', async () => {
    const { downloads, server, storage } = await setupDownloads()
    server.rule(fakeMediaUrl(track(1), 1), { holdAt: 1500 })
    await downloads.manager.enqueue(track(1))
    const { user } = renderApp('/library?tab=downloads')
    await user.click(await main().findByRole('button', { name: 'Cancel the download of Song 1' }))
    await waitFor(() =>
      expect(main().queryByRole('list', { name: 'Downloads on their way' })).toBeNull(),
    )
    await waitFor(async () => expect(await storage.list()).toEqual([]))
    expect(await downloads.manager.list()).toEqual([])
  })

  it('pauses and resumes everything, and offers a retry after a failure', async () => {
    const { downloads, server, resolver } = await setupDownloads()
    for (const n of [1, 2]) server.rule(fakeMediaUrl(track(n), n), { holdAt: 1500 })
    await downloads.manager.enqueueAll([track(1), track(2)])
    const { user } = renderApp('/library?tab=downloads')
    await user.click(await main().findByRole('button', { name: 'Pause all' }))
    expect(await main().findByRole('button', { name: 'Resume all' })).toBeInTheDocument()
    await waitFor(() => expect(main().queryByRole('button', { name: 'Pause all' })).toBeNull())
    resolver.handler = () => {
      throw Object.assign(new Error('no space'), { name: 'QuotaExceededError' })
    }
    await user.click(main().getByRole('button', { name: 'Resume all' }))
    expect(
      await main().findByRole('button', { name: 'Try downloading Song 1 again' }),
    ).toBeInTheDocument()
    expect(main().getAllByText(/There is no room left for downloads/)).not.toHaveLength(0)
  })

  it('asks about the one download there is', async () => {
    const { downloads } = await setupDownloads()
    await downloads.manager.enqueue(track(1))
    const { user } = renderApp('/library?tab=downloads')
    await within(await main().findByRole('list', { name: 'Songs in Downloads' })).findByText(
      'Song 1',
    )
    await user.click(main().getByRole('button', { name: 'Remove all downloads' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove download?' })
    expect(within(dialog).getByText(/“Song 1” won’t play offline any more/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('removes every download after asking', async () => {
    const { downloads, storage } = await setupDownloads()
    await downloads.manager.enqueueAll([track(1), track(2)])
    const { user } = renderApp('/library?tab=downloads')
    const songs = await main().findByRole('list', { name: 'Songs in Downloads' })
    await within(songs).findByText('Song 2')
    await within(songs).findByText('Song 1')
    await user.click(main().getByRole('button', { name: 'Remove all downloads' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 downloads?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove downloads' }))
    expect(await main().findByRole('heading', { name: 'No downloads yet' })).toBeInTheDocument()
    await waitFor(async () => expect(await storage.list()).toEqual([]))
  })

  it("lists songs in Downloads that aren't on this device, to download or remove", async () => {
    await setupDownloads()
    await getLibrary().addDownload(track(3))
    await getLibrary().addDownload(track(4))
    const { user } = renderApp('/library?tab=downloads')
    expect(
      await main().findByText('2 songs in Downloads aren’t downloaded on this device.'),
    ).toBeInTheDocument()
    await user.click(main().getByRole('button', { name: 'Download them' }))
    await waitFor(() => expect(main().queryByText(/aren’t downloaded on this device/)).toBeNull())
  })

  it('takes songs that are not on this device out of Downloads', async () => {
    await setupDownloads()
    await getLibrary().addDownload(track(3))
    const { user } = renderApp('/library?tab=downloads')
    await main().findByText('1 song in Downloads isn’t downloaded on this device.')
    await user.click(main().getByRole('button', { name: 'Remove from Downloads' }))
    expect(await main().findByRole('heading', { name: 'No downloads yet' })).toBeInTheDocument()
  })

  it('says why YouTube songs are not offered for download in the Lite tier', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    await setupDownloads({ tier: 'lite' })
    renderApp('/library?tab=downloads')
    expect(
      await main().findByText(/Downloading songs from YouTube Music takes FXM Connect/),
    ).toBeInTheDocument()
  })

  it("doesn't offer FXM Connect for YouTube's downloads where it can't be added", async () => {
    asBrowser(USER_AGENTS.iphone)
    await setupDownloads({ tier: 'lite' })
    renderApp('/library?tab=downloads')
    expect(
      await main().findByText(
        "Downloads of YouTube Music songs need FXM Connect, which isn't available on iPhone and iPad. Songs from Internet Archive download here.",
      ),
    ).toBeInTheDocument()
  })

  it('says why it paused the other downloads after a bot check', async () => {
    const { downloads, resolver } = await setupDownloads()
    resolver.handler = () => {
      throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
    }
    await downloads.manager.enqueueAll([track(1), track(2), track(3)])
    renderApp('/library?tab=downloads')
    const list = await main().findByRole('list', { name: 'Downloads on their way' })
    expect(
      await within(list).findByText(`Paused · ${ERROR_TEXT['bot-check']}`, { exact: false }),
    ).toBeInTheDocument()
    expect(within(list).getAllByText(ERROR_TEXT['bot-check'], { exact: false })).toHaveLength(3)
    expect(resolver.calls).toHaveLength(2)
  })

  it('says when the browser cannot store downloads', async () => {
    await setupDownloads({ supported: false })
    renderApp('/library?tab=downloads')
    expect(
      await main().findByText(
        /This browser can’t store downloads|This browser can't store downloads/,
      ),
    ).toBeInTheDocument()
  })
})

describe('downloading from the library', { timeout: 30_000 }, () => {
  it('downloads a song from its menu in Liked songs, and saves its file', async () => {
    const { downloads } = await setupDownloads()
    const requests: SaveRequest[] = []
    const written: Blob[] = []
    setDeviceSaver({
      choose: async (request) => {
        requests.push(request)
        return {
          fileName: request.fileName,
          write: async (blob) => void written.push(blob),
          discard: async () => {},
        }
      },
    })
    setConverter(createInProcessConverter())
    setLyricsProvider({ id: 'fake', getLyrics: async () => null })
    useQualityStore.getState().setDownloadFormat('mp3')
    await getLibrary().like(track(2))
    const { user } = renderApp('/library?tab=liked')
    await main().findByRole('list', { name: 'Songs in Liked songs' })
    const menu = await openRowMenu(user, 'Song 2')
    await user.click(await within(menu).findByRole('menuitem', { name: 'Download' }))
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))
    expect(await screen.findByText('Saved “Song 2” as Artist 2 - Song 2.mp3')).toBeInTheDocument()
    expect(requests.map((request) => request.fileName)).toEqual(['Artist 2 - Song 2.mp3'])
    expect(written).toHaveLength(1)
    expect((await downloads.manager.get(track(2)))?.status).toBe('completed')
    const again = await openRowMenu(user, 'Song 2')
    expect(
      await within(again).findByRole('menuitem', { name: 'Remove download' }),
    ).toBeInTheDocument()
    expect(within(again).getByRole('menuitem', { name: 'Save to device…' })).toBeInTheDocument()
  })

  it('keeps an offline copy only, with saving a file switched off', async () => {
    const { downloads } = await setupDownloads()
    useQualityStore.getState().setSaveFile(false)
    await getLibrary().like(track(2))
    const { user } = renderApp('/library?tab=liked')
    await main().findByRole('list', { name: 'Songs in Liked songs' })
    const menu = await openRowMenu(user, 'Song 2')
    await user.click(await within(menu).findByRole('menuitem', { name: 'Download' }))
    expect(await screen.findByText('Downloading “Song 2”')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(async () =>
      expect((await downloads.manager.get(track(2)))?.status).toBe('completed'),
    )
    const again = await openRowMenu(user, 'Song 2')
    expect(
      await within(again).findByRole('menuitem', { name: 'Remove download' }),
    ).toBeInTheDocument()
  })

  it('asks once for a whole playlist in the Download dialog', async () => {
    await setupDownloads()
    const id = await getLibrary().createPlaylist({
      name: 'Road trip',
      tracks: [track(1), track(2), track(3)],
    })
    const { user } = renderApp(playlistPath(id))
    await main().findByRole('list', { name: 'Songs in Road trip' })
    await user.click(main().getByRole('button', { name: 'More options for Road trip' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Download all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(dialog).toHaveAccessibleDescription('“Road trip” · 3 songs')
    expect(await within(dialog).findByRole('group', { name: 'Format' })).toBeInTheDocument()
  })

  it('downloads a selection, and a whole playlist, with saving a file switched off', async () => {
    const { downloads } = await setupDownloads()
    useQualityStore.getState().setSaveFile(false)
    const id = await getLibrary().createPlaylist({
      name: 'Road trip',
      tracks: [track(1), track(2), track(3)],
    })
    const { user } = renderApp(playlistPath(id))
    await main().findByRole('list', { name: 'Songs in Road trip' })
    await user.click(main().getByRole('button', { name: 'More options for Road trip' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Download all' }))
    expect(await screen.findByText('Downloading 3 songs')).toBeInTheDocument()
    await waitFor(async () => expect(await downloads.manager.list()).toHaveLength(3))
    await waitFor(async () =>
      expect(
        (await downloads.manager.list()).every((record) => record.status === 'completed'),
      ).toBe(true),
    )
    await user.click(main().getByRole('button', { name: 'More options for Road trip' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Download all' }))
    expect(await screen.findByText('These songs are already in Downloads')).toBeInTheDocument()
  })

  it('offers no download where the bytes are unreadable', async () => {
    const { downloads } = await setupDownloads({ tier: 'lite' })
    await getLibrary().like(track(2))
    await getLibrary().like(track(3))
    await storeCompleted(downloads, track(3))
    const { user } = renderApp('/library?tab=liked')
    await main().findByRole('list', { name: 'Songs in Liked songs' })
    await waitForStatuses(user, 'Song 3')
    const menu = await openRowMenu(user, 'Song 2')
    expect(within(menu).queryByRole('menuitem', { name: 'Download' })).toBeNull()
  })

  it('offers no download of a song the app cannot resolve yet', async () => {
    await resetDownloads({
      storage: createMemoryDownloadStorage(),
      environment: createPendingEnvironment(),
    })
    const archive = {
      ...track(2),
      id: formatId('archive', 'track', 'item/song-2.flac'),
      source: 'archive' as const,
    }
    await getLibrary().like(archive)
    await getLibrary().like(track(3))
    await storeCompleted(getDownloads(), track(3))
    const { user } = renderApp('/library?tab=liked')
    await main().findByRole('list', { name: 'Songs in Liked songs' })
    await waitForStatuses(user, 'Song 3')
    const menu = await openRowMenu(user, 'Song 2')
    expect(within(menu).queryByRole('menuitem', { name: 'Download' })).toBeNull()
  })

  it('cancels a download from a song menu', async () => {
    const { downloads, server } = await setupDownloads()
    server.rule(fakeMediaUrl(track(2), 1), { holdAt: 1500 })
    await getLibrary().like(track(2))
    await downloads.manager.enqueue(track(2))
    const { user } = renderApp('/library?tab=liked')
    await main().findByRole('list', { name: 'Songs in Liked songs' })
    const menu = await openRowMenu(user, 'Song 2')
    // The menu follows the downloads as they are read.
    await user.click(await within(menu).findByRole('menuitem', { name: 'Cancel download' }))
    await waitFor(async () =>
      expect(await downloads.store.get(downloadId(track(2)))).toBeUndefined(),
    )
  })
})
