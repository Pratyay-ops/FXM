import {
  ConvertError,
  type Converter,
  type DeviceSaver,
  type SaveFolder,
  type SaveRequest,
} from '@fxm/convert'
import {
  createInProcessConverter,
  FakeFfmpegCore,
  readFlacBlocks,
  readVorbisComments,
} from '@fxm/convert/testing'
import type { Track } from '@fxm/core'
import { downloadId } from '@fxm/downloads'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../../db/types'
import { track } from '../../../test/library-fixtures'
import { INITIAL_CONNECTION, useConnection } from '../../connect/connection'
import { setLyricsProvider } from '../../lyrics/lyrics-source'
import { useFeedbackStore } from '../../search/feedback'
import { useQualityStore } from '../../settings/quality-store'
import { requestDownload } from '../actions'
import { useSaveMenuItem } from '../menu'
import { getDownloads } from '../runtime'
import { setupDownloads } from '../testing'
import { DownloadDialog } from './download-dialog'
import { DownloadDialogHost } from './download-dialog-host'
import type { DownloadDialogRequest } from './download-dialog-store'
import { SAVE_ERROR_TEXT, setConverter, setDeviceSaver } from './save'

afterEach(() => {
  useConnection.setState(INITIAL_CONNECTION, true)
})

/** Where a fake device saver puts what it saves, and what it was asked. */
interface FakeSaverLog {
  /** What `choose` was asked, with the song's download status at that moment. */
  readonly requests: SaveRequest[]
  readonly written: { name: string; blob: Blob }[]
  readonly counts: { discarded: number; folders: number }
}

/**
 * A device saver that records what it is asked, what it writes and what it gives up. `asks`:
 * its `choose` shows a picker that needs a click (Chromium's). `folder`: it picks folders for
 * several files (`null`: it can't). `cancel`: the user closes its picker.
 */
function fakeSaver(
  options: { cancel?: boolean; asks?: boolean; folder?: string | null; onChoose?: () => void } = {},
): FakeSaverLog {
  const log: FakeSaverLog = { requests: [], written: [], counts: { discarded: 0, folders: 0 } }
  const target = (fileName: string) => ({
    fileName,
    write: async (blob: Blob) => {
      log.written.push({ name: fileName, blob })
    },
    discard: async () => {
      log.counts.discarded += 1
    },
  })
  const saver: DeviceSaver = {
    choose: async (request) => {
      options.onChoose?.()
      log.requests.push(request)
      if (options.cancel) return undefined
      return target(request.fileName)
    },
    asksWhere: () => options.asks === true,
    ...(options.folder === undefined
      ? {}
      : {
          chooseFolder: async () => {
            log.counts.folders += 1
            if (options.cancel) return undefined
            if (options.folder === null) return null
            const folder: SaveFolder = {
              name: options.folder ?? 'Music',
              target: (request) => target(request.fileName),
            }
            return folder
          },
        }),
  }
  setDeviceSaver(saver)
  return log
}

/** A converter whose jobs run until they are cancelled, as a long conversion does. */
function endlessConverter() {
  const signals: AbortSignal[] = []
  const converter: Converter = {
    exportAudio: (_job, options = {}) =>
      new Promise((_resolve, reject) => {
        const { signal } = options
        if (signal === undefined) return
        signals.push(signal)
        signal.addEventListener(
          'abort',
          () => reject(new ConvertError('cancelled', 'The conversion was cancelled')),
          { once: true },
        )
      }),
    dispose: () => {},
  }
  setConverter(converter)
  return { signals }
}

/** Lyrics from a fake: nothing reaches LRCLIB from a test. */
function fakeLyrics() {
  setLyricsProvider({
    id: 'fake',
    getLyrics: async () => ({ synced: false, source: 'fake', lines: [{ text: 'La la' }] }),
  })
}

/** The downloads on fakes, with `songs` downloaded already. */
async function withDownloads(songs: Track[] = [], options: { run?: boolean } = {}) {
  fakeLyrics()
  const setup = await setupDownloads(options)
  for (const song of songs) {
    await setup.downloads.manager.enqueue(song)
    await waitFor(async () => {
      expect((await setup.downloads.manager.get(song))?.status).toBe('completed')
    })
  }
  return setup
}

/** A song downloaded on this device. */
async function downloaded(n = 1): Promise<Track> {
  const song = track(n)
  await withDownloads([song])
  return song
}

/** The download status of `song` now: `none` without one. */
async function statusOf(song: Track): Promise<string> {
  return (await getDownloads().manager.get(song))?.status ?? 'none'
}

function Harness({
  request,
  closer,
}: {
  request: DownloadDialogRequest
  closer?: { close?: () => void }
}) {
  const [open, setOpen] = useState(true)
  if (closer) closer.close = () => setOpen(false)
  return (
    <>
      <p>{open ? 'open' : 'closed'}</p>
      <DownloadDialog request={open ? request : null} onClose={() => setOpen(false)} />
    </>
  )
}

/** Opens Save to device for `song`, picks `format` and presses Save. */
async function startSaving(song: Track, format: RegExp, closer?: { close?: () => void }) {
  const user = userEvent.setup()
  render(<Harness request={{ tracks: [song], save: true }} {...(closer ? { closer } : {})} />)
  const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
  await user.click(await within(dialog).findByRole('radio', { name: format }))
  await user.click(within(dialog).getByRole('button', { name: 'Save' }))
  return { user, dialog }
}

/** The labels of the dialog's formats, with their extensions. */
async function formatLabels(dialog: HTMLElement): Promise<(string | null | undefined)[]> {
  const formats = await within(dialog).findByRole('group', { name: 'Format' })
  return within(formats)
    .getAllByRole('radio')
    .map((radio) => radio.closest('label')?.textContent)
}

/** The titles in the Downloads playlist. */
async function downloadsPlaylist(): Promise<string[]> {
  const view = await getLibrary().getPlaylistView(DOWNLOADS_PLAYLIST_ID)
  return (view?.rows ?? []).map((row) => row.track?.title ?? '')
}

describe('Download', { timeout: 30_000 }, () => {
  it('asks for the format, starting at the setting, in honest words before the download', async () => {
    await withDownloads()
    useQualityStore.getState().setDownloadFormat('flac')
    render(<Harness request={{ tracks: [track(1)] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(dialog).toHaveAccessibleDescription('“Song 1”')
    expect(await formatLabels(dialog)).toEqual([
      'Original',
      'FLAC.flac',
      'ALAC.m4a',
      'WAV.wav',
      'MP3.mp3',
      'AAC.m4a',
      'Opus.opus',
    ])
    expect(within(dialog).getByRole('radio', { checked: true })).toHaveAccessibleName('FLAC .flac')
    expect(dialog).toHaveTextContent(
      'A YouTube song in Opus: FLAC (converted from Opus, same quality as the source).',
    )
    expect(dialog).toHaveTextContent(
      'YouTube audio is never lossless: converting it gives a bigger file, not a better one.',
    )
    expect(dialog).toHaveTextContent('The song also stays in Downloads, to play offline.')
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeEnabled()
    // Nothing downloads before the button is pressed.
    expect(await statusOf(track(1))).toBe('none')
  })

  it('asks where to save from the click, then downloads, converts, tags and saves', async () => {
    await withDownloads()
    const song = track(1)
    const statusAtChoice: string[] = []
    const saver = fakeSaver({
      asks: true,
      onChoose: () => {
        void statusOf(song).then((status) => statusAtChoice.push(status))
      },
    })
    setConverter(createInProcessConverter())
    useQualityStore.getState().setDownloadFormat('flac')
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [song] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))

    await screen.findByText('closed')
    // The picker came first, before anything was downloaded.
    expect(saver.requests).toEqual([
      { fileName: 'Artist 1 - Song 1.flac', mimeType: 'audio/flac', description: 'FLAC audio' },
    ])
    expect(statusAtChoice).toEqual(['none'])
    expect(useFeedbackStore.getState().message).toBe('Saved “Song 1” as Artist 1 - Song 1.flac')
    const saved = new Uint8Array(await (saver.written[0] as { blob: Blob }).blob.arrayBuffer())
    const comments = readVorbisComments(readFlacBlocks(saved).blocks[1]?.body ?? new Uint8Array())
    expect(comments.fields).toContainEqual(['TITLE', 'Song 1'])
    expect(comments.fields).toContainEqual(['LYRICS', 'La la'])
    // The song stays downloaded in FXM: it plays offline and is in Downloads.
    expect(await statusOf(song)).toBe('completed')
    await waitFor(async () => expect(await downloadsPlaylist()).toEqual(['Song 1']))
  })

  it('asks where an original goes once it is downloaded, where the picker needs a click', async () => {
    await withDownloads()
    const song = track(1)
    const saver = fakeSaver({ asks: true })
    setConverter(createInProcessConverter())
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [song] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(await within(dialog).findByRole('radio', { checked: true })).toHaveAccessibleName(
      'Original',
    )
    expect(dialog).toHaveTextContent(
      'FXM asks where to save once the song is downloaded: only then is its file type known.',
    )
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))

    // Downloaded, without asking: the file type is the download's.
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '“Song 1” is downloaded. Press Save to choose where its file goes.',
    )
    expect(saver.requests).toEqual([])
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('“Song 1” · downloaded as Opus · 150 kbps'),
    )
    expect(within(dialog).getByRole('radio', { checked: true })).toHaveAccessibleName(
      'Original (Opus) .webm',
    )
    const save = within(dialog).getByRole('button', { name: 'Save' })
    await waitFor(() => expect(save).toHaveFocus())

    await user.click(save)
    await screen.findByText('closed')
    expect(saver.requests.map((request) => request.fileName)).toEqual(['Artist 1 - Song 1.webm'])
    expect(saver.written).toHaveLength(1)
  })

  it('saves an original by itself where saving needs no click (the browser’s downloads)', async () => {
    await withDownloads()
    const saver = fakeSaver({ asks: false })
    setConverter(createInProcessConverter())
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [track(1)] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(dialog).not.toHaveTextContent('FXM asks where to save once')
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))

    await screen.findByText('closed')
    expect(saver.requests.map((request) => request.fileName)).toEqual(['Artist 1 - Song 1.webm'])
    expect(saver.written).toHaveLength(1)
    expect(useFeedbackStore.getState().message).toMatch(
      /^Saved “Song 1” as Artist 1 - Song 1\.webm/,
    )
  })

  it('saves a song downloaded already from its copy, without the network', async () => {
    const song = track(1)
    const setup = await withDownloads([song])
    const calls = setup.resolver.calls.length
    const requests = setup.server.requests.length
    const saver = fakeSaver({ asks: true })
    const converter = createInProcessConverter()
    setConverter(converter)
    useQualityStore.getState().setDownloadFormat('mp3')
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [song] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('“Song 1” · downloaded as Opus · 150 kbps'),
    )
    // The exact formats of its file, as Save to device offers them.
    expect(within(dialog).getByRole('radio', { checked: true })).toHaveAccessibleName(
      'MP3 (converted from Opus, some quality loss) .mp3',
    )
    expect(dialog).not.toHaveTextContent('stays in Downloads')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await screen.findByText('closed')
    expect(saver.requests.map((request) => request.fileName)).toEqual(['Artist 1 - Song 1.mp3'])
    expect(converter.jobs).toHaveLength(1)
    expect(setup.resolver.calls).toHaveLength(calls)
    expect(setup.server.requests).toHaveLength(requests)
  })

  it('downloads and saves a collection into one folder, asked for once', async () => {
    const first = track(1)
    const setup = await withDownloads([first])
    const calls = setup.resolver.calls.length
    const saver = fakeSaver({ asks: true, folder: 'Music' })
    setConverter(createInProcessConverter())
    useQualityStore.getState().setDownloadFormat('flac')
    const songs = [first, track(2), track(3)]
    const user = userEvent.setup()
    render(<Harness request={{ tracks: songs, title: 'Road trip' }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(dialog).toHaveAccessibleDescription('“Road trip” · 3 songs')
    expect(
      await within(dialog).findByText('1 song is downloaded already: FXM saves it from its copy.'),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      'FXM asks for a folder and saves each song there as soon as it’s ready.',
    )
    expect(dialog).toHaveTextContent('The songs also stay in Downloads, to play offline.')
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))

    await screen.findByText('closed')
    expect(saver.counts.folders).toBe(1)
    expect(saver.requests).toEqual([])
    expect(saver.written.map((file) => file.name)).toEqual([
      'Artist 1 - Song 1.flac',
      'Artist 2 - Song 2.flac',
      'Artist 3 - Song 3.flac',
    ])
    expect(useFeedbackStore.getState().message).toBe('Saved 3 songs to “Music”')
    // Only the two new songs were downloaded; all three stay downloaded, in Downloads.
    expect(setup.resolver.calls.length - calls).toBe(2)
    for (const song of songs) expect(await statusOf(song)).toBe('completed')
    await waitFor(async () =>
      expect((await downloadsPlaylist()).sort()).toEqual(['Song 1', 'Song 2', 'Song 3']),
    )
  })

  it('saves each song of a collection to the browser’s downloads where there is no folder picker', async () => {
    await withDownloads()
    // The browser's own saver, in a browser without the File System Access pickers (Firefox,
    // Safari): each file is a download through a link.
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download)
    })
    const url = URL as unknown as Record<string, unknown>
    url.createObjectURL ??= () => 'blob:fxm/test'
    url.revokeObjectURL ??= () => {}
    setConverter(createInProcessConverter())
    useQualityStore.getState().setDownloadFormat('mp3')
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [track(1), track(2)], title: 'Album 1' }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    expect(
      await within(dialog).findByText(
        /If the browser asks whether FXM may download several files, allow it\./,
      ),
    ).toBeInTheDocument()
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))

    await screen.findByText('closed')
    expect(downloads).toEqual(['Artist 1 - Song 1.mp3', 'Artist 2 - Song 2.mp3'])
    expect(useFeedbackStore.getState().message).toBe('Saved 2 songs to your browser’s downloads')
  })

  it('stays open when the user cancels the folder picker, downloading nothing', async () => {
    await withDownloads()
    const saver = fakeSaver({ asks: true, folder: 'Music', cancel: true })
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [track(1), track(2)] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))
    expect(saver.counts.folders).toBe(1)
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(await statusOf(track(1))).toBe('none')
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeEnabled()
  })

  it('cancels with Cancel: the download it started, and the place it picked', async () => {
    // No tab runs the queue: the download waits until it is cancelled.
    await withDownloads([], { run: false })
    const song = track(1)
    const saver = fakeSaver({ asks: true })
    useQualityStore.getState().setDownloadFormat('wav')
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [song] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))
    expect(await within(dialog).findByRole('button', { name: 'Downloading…' })).toBeDisabled()
    expect(
      await within(dialog).findByRole('progressbar', { name: 'Downloading Song 1' }),
    ).toHaveAccessibleDescription('')
    expect(dialog).toHaveTextContent('Downloading · Waiting')
    await waitFor(async () => expect(await statusOf(song)).toBe('queued'))

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await within(dialog).findByRole('button', { name: 'Download' })).toBeEnabled()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await waitFor(async () => expect(await statusOf(song)).toBe('none'))
    await waitFor(() => expect(saver.counts.discarded).toBe(1))
    expect(saver.written).toEqual([])
  })

  it('says why a download failed, and saves nothing', async () => {
    const setup = await withDownloads()
    const saver = fakeSaver({ asks: true })
    useQualityStore.getState().setDownloadFormat('flac')
    // FXM Connect went away after the dialog opened: YouTube songs can't be downloaded now.
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [track(1)] }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Download' })
    act(() => setup.setTier('free'))
    await user.click(await within(dialog).findByRole('button', { name: 'Download' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '“Song 1” can’t be downloaded here.',
    )
    await waitFor(() => expect(saver.counts.discarded).toBe(1))
    expect(saver.written).toEqual([])
  })
})

describe('Download from the menus', { timeout: 30_000 }, () => {
  it('opens the Download dialog with the setting on', async () => {
    await withDownloads()
    fakeSaver()
    render(<DownloadDialogHost />)
    act(() => requestDownload([track(1)]))
    expect(await screen.findByRole('dialog', { name: 'Download' })).toBeVisible()
    expect(await statusOf(track(1))).toBe('none')
  })

  it('keeps an offline copy only with the setting off, as before', async () => {
    await withDownloads()
    const saver = fakeSaver()
    useQualityStore.getState().setSaveFile(false)
    render(<DownloadDialogHost />)
    act(() => requestDownload([track(1)]))
    await waitFor(() => expect(useFeedbackStore.getState().message).toBe('Downloading “Song 1”'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(async () => expect(await statusOf(track(1))).toBe('completed'))
    expect(saver.requests).toEqual([])
  })

  it('keeps an offline copy only where no file can be saved, and says so', async () => {
    await withDownloads([track(2)])
    // The Android app, which has no saver of its own yet: its web view saves no downloads.
    useConnection.setState({ platform: 'android' })
    render(<DownloadDialogHost />)
    act(() => requestDownload([track(1)]))
    await waitFor(() =>
      expect(useFeedbackStore.getState().message).toBe(
        'Downloading “Song 1”. Saving files isn’t available here, so it plays offline in FXM only',
      ),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(async () => expect(await statusOf(track(1))).toBe('completed'))

    // Nor does a downloaded song offer Save to device there.
    function Menu({ row }: { row: Track }) {
      const item = useSaveMenuItem(() => {})({ id: row.id, track: row })
      const label = item !== undefined && !('kind' in item) ? item.label : 'none'
      return <p data-testid={row.id}>{label}</p>
    }
    render(<Menu row={track(2)} />)
    await waitFor(() => expect(screen.getByTestId(track(2).id)).toHaveTextContent('none'))
    act(() => useConnection.setState({ platform: 'web' }))
    await waitFor(() =>
      expect(screen.getByTestId(track(2).id)).toHaveTextContent('Save to device…'),
    )
  })

  it('saves files in the Android app once it sets a saver of its own', async () => {
    await withDownloads()
    useConnection.setState({ platform: 'android' })
    fakeSaver()
    render(<DownloadDialogHost />)
    act(() => requestDownload([track(1)]))
    expect(await screen.findByRole('dialog', { name: 'Download' })).toBeVisible()
  })
})

describe('Save to device', { timeout: 30_000 }, () => {
  it('offers every format with its honest label, starting at the download setting', async () => {
    const song = await downloaded()
    useQualityStore.getState().setDownloadFormat('flac')
    render(<Harness request={{ tracks: [song], save: true }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    const formats = await within(dialog).findByRole('group', { name: 'Format' })
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('“Song 1” · downloaded as Opus · 150 kbps'),
    )
    const labels = await formatLabels(dialog)
    expect(labels).toEqual([
      'Original (Opus).webm',
      'FLAC (converted from Opus, same quality as the source).flac',
      'ALAC (converted from Opus, same quality as the source).m4a',
      'WAV (converted from Opus, same quality as the source).wav',
      'MP3 (converted from Opus, some quality loss).mp3',
      'AAC (converted from Opus, some quality loss).m4a',
      'Opus (no conversion).opus',
    ])
    expect(within(formats).getByRole('radio', { checked: true })).toHaveAccessibleName(
      'FLAC (converted from Opus, same quality as the source) .flac',
    )
    expect(dialog).toHaveTextContent(
      'Opus is never lossless: converting it gives a bigger file, not a better one.',
    )
    // YouTube audio is never called lossless.
    expect(labels.join(' ')).not.toMatch(/\blossless\b/i)
  })

  it('offers the original alone while conversions are off, whatever the setting', async () => {
    const song = await downloaded()
    useQualityStore.getState().setDownloadFormat('flac')
    const saver = fakeSaver()
    setConverter(createInProcessConverter())
    const user = userEvent.setup()
    render(
      <DownloadDialog
        request={{ tracks: [song], save: true }}
        onClose={() => {}}
        conversions={false}
      />,
    )
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    const formats = await within(dialog).findByRole('group', { name: 'Format' })
    const radios = within(formats).getAllByRole('radio')
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Original (Opus).webm',
    ])
    expect(radios[0]).toBeChecked()

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saver.written).toHaveLength(1))
    expect(saver.requests.map((request) => request.fileName)).toEqual(['Artist 1 - Song 1.webm'])
  })

  it('asks where to save, converts with tags, writes the file and says so', async () => {
    const song = await downloaded()
    const saver = fakeSaver()
    setConverter(createInProcessConverter())
    await startSaving(song, /^FLAC/)
    await screen.findByText('closed')
    expect(saver.requests).toEqual([
      { fileName: 'Artist 1 - Song 1.flac', mimeType: 'audio/flac', description: 'FLAC audio' },
    ])
    const saved = new Uint8Array(await (saver.written[0] as { blob: Blob }).blob.arrayBuffer())
    const comments = readVorbisComments(readFlacBlocks(saved).blocks[1]?.body ?? new Uint8Array())
    expect(comments.fields).toContainEqual(['TITLE', 'Song 1'])
    expect(comments.fields).toContainEqual(['LYRICS', 'La la'])
    expect(useFeedbackStore.getState().message).toBe('Saved “Song 1” as Artist 1 - Song 1.flac')
  })

  it('stays open when the user cancels the picker, and says why a conversion failed', async () => {
    const song = await downloaded()
    const cancelling = fakeSaver({ cancel: true })
    const core = new FakeFfmpegCore()
    setConverter(createInProcessConverter(core))
    const { user, dialog } = await startSaving(song, /^MP3/)
    expect(cancelling.requests).toHaveLength(1)
    expect(screen.getByText('open')).toBeInTheDocument()

    fakeSaver()
    core.failNext = new ConvertError('core-unavailable', 'HTTP 404')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Converting doesn't work in this browser right now. Save the original instead, or reload FXM and try again.",
    )
  })

  it('cancels a running conversion with Cancel, and stays open to try again', async () => {
    const song = await downloaded()
    const saver = fakeSaver()
    const { signals } = endlessConverter()
    const { user, dialog } = await startSaving(song, /^FLAC/)
    expect(await within(dialog).findByRole('button', { name: 'Saving…' })).toBeDisabled()
    await waitFor(() => expect(signals).toHaveLength(1))

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(signals[0]?.aborted).toBe(true)
    expect(await within(dialog).findByRole('button', { name: 'Save' })).toBeEnabled()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(screen.getByText('open')).toBeInTheDocument()
    // The place picked for the file is given up: no empty file stays behind.
    await waitFor(() => expect(saver.counts.discarded).toBe(1))
    expect(saver.written).toEqual([])
    // The download stays.
    expect(await statusOf(song)).toBe('completed')
  })

  it('cancels the conversion when the dialog closes, and then changes nothing', async () => {
    const song = await downloaded()
    const saver = fakeSaver()
    const { signals } = endlessConverter()
    const errors = vi.spyOn(console, 'error')
    const closer: { close?: () => void } = {}
    await startSaving(song, /^MP3/, closer)
    await waitFor(() => expect(signals).toHaveLength(1))
    useFeedbackStore.setState({ message: null } as never)

    act(() => closer.close?.())
    await screen.findByText('closed')
    expect(signals[0]?.aborted).toBe(true)
    await waitFor(() => expect(saver.counts.discarded).toBe(1))
    // No confirmation, no error and no update of the closed dialog.
    expect(useFeedbackStore.getState().message).toBeFalsy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(errors).not.toHaveBeenCalled()
  })

  it('says so when the device can’t ask where to save, converting nothing', async () => {
    const song = await downloaded()
    const converter = createInProcessConverter()
    setConverter(converter)
    setDeviceSaver({
      choose: async () => {
        throw new Error('The native save dialog failed')
      },
    })
    const { dialog } = await startSaving(song, /^WAV/)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      SAVE_ERROR_TEXT['write-failed'],
    )
    expect(converter.jobs).toEqual([])
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('says a download FXM can’t read can’t be saved, instead of failing to open', async () => {
    const song = await downloaded()
    // A stored video whose audio isn't AAC in MP4, which no source delivers.
    await getDownloads().db.downloads.update(downloadId(song), {
      format: { codec: 'opus', container: 'webm', media: 'muxed-video', tier: 'normal' },
    })
    render(<Harness request={{ tracks: [song], save: true }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    expect(
      await within(dialog).findByText(/FXM can’t save this download: its file isn’t in a format/),
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('credits FFmpeg, LAME and Opus with a link to their licences and sources', async () => {
    const song = await downloaded()
    const user = userEvent.setup()
    render(<Harness request={{ tracks: [song], save: true }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    await user.click(await within(dialog).findByRole('radio', { name: /^FLAC/ }))
    expect(dialog).toHaveTextContent(/converts with code of FFmpeg .*licensed under the LGPLv2\.1/)
    expect(
      within(dialog)
        .getByRole('link', { name: /licences and sources/ })
        .getAttribute('href'),
    ).toBe('/third-party-notices.txt')
    expect(dialog).toHaveTextContent('FXM converts it on this device')
    // The original WebM is only remuxed, for its tags: nothing is converted.
    await user.click(within(dialog).getByRole('radio', { name: /^Original/ }))
    expect(dialog).not.toHaveTextContent('FXM converts it')
    expect(dialog).toHaveTextContent('The audio exactly as downloaded')
  })

  it('says so when the song isn’t downloaded here', async () => {
    await downloaded()
    render(<Harness request={{ tracks: [track(9)], save: true }} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    expect(await within(dialog).findByText(/isn’t downloaded on this device/)).toBeInTheDocument()
  })

  it('is in the menu of downloaded songs only', async () => {
    const song = await downloaded()
    const opened: Track[] = []
    function Menu({ row }: { row: Track }) {
      const item = useSaveMenuItem((chosen) => opened.push(chosen))({ id: row.id, track: row })
      const label = item !== undefined && !('kind' in item) ? item.label : 'none'
      return <p data-testid={row.id}>{label}</p>
    }
    render(
      <>
        <Menu row={song} />
        <Menu row={track(5)} />
      </>,
    )
    await waitFor(() => expect(screen.getByTestId(song.id)).toHaveTextContent('Save to device…'))
    expect(screen.getByTestId(track(5).id)).toHaveTextContent('none')
  })
})
