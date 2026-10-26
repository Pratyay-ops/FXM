import { ConvertError, type Converter, type DeviceSaver, type SaveRequest } from '@fxm/convert'
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
import { describe, expect, it, vi } from 'vitest'
import { track } from '../../../test/library-fixtures'
import { setLyricsProvider } from '../../lyrics/lyrics-source'
import { useFeedbackStore } from '../../search/feedback'
import { useQualityStore } from '../../settings/quality-store'
import { useSaveMenuItem } from '../menu'
import { getDownloads } from '../runtime'
import { setupDownloads } from '../testing'
import { SAVE_ERROR_TEXT, setConverter, setDeviceSaver } from './save'
import { SaveToDeviceDialog } from './save-dialog'

/** A device saver that records what it is asked, what it writes and what it gives up. */
function fakeSaver(options: { cancel?: boolean } = {}) {
  const requests: SaveRequest[] = []
  const written: Blob[] = []
  const counts = { discarded: 0 }
  const saver: DeviceSaver = {
    choose: async (request) => {
      requests.push(request)
      if (options.cancel) return undefined
      return {
        fileName: request.fileName,
        write: async (blob) => {
          written.push(blob)
        },
        discard: async () => {
          counts.discarded += 1
        },
      }
    },
  }
  setDeviceSaver(saver)
  return { requests, written, counts }
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

async function downloaded(n = 1): Promise<Track> {
  // Lyrics from a fake: nothing reaches LRCLIB from a test.
  setLyricsProvider({
    id: 'fake',
    getLyrics: async () => ({ synced: false, source: 'fake', lines: [{ text: 'La la' }] }),
  })
  const setup = await setupDownloads()
  const song = track(n)
  await setup.downloads.manager.enqueue(song)
  await waitFor(async () => {
    expect((await setup.downloads.manager.get(song))?.status).toBe('completed')
  })
  return song
}

function Harness({ song, closer }: { song: Track; closer?: { close?: () => void } }) {
  const [open, setOpen] = useState(true)
  if (closer) closer.close = () => setOpen(false)
  return (
    <>
      <p>{open ? 'open' : 'closed'}</p>
      <SaveToDeviceDialog track={open ? song : null} onClose={() => setOpen(false)} />
    </>
  )
}

/** Opens the dialog for `song`, picks `format` and presses Save. */
async function startSaving(song: Track, format: RegExp, closer?: { close?: () => void }) {
  const user = userEvent.setup()
  render(<Harness song={song} {...(closer ? { closer } : {})} />)
  const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
  await user.click(await within(dialog).findByRole('radio', { name: format }))
  await user.click(within(dialog).getByRole('button', { name: 'Save' }))
  return { user, dialog }
}

describe('Save to device', { timeout: 30_000 }, () => {
  it('offers every format with its honest label, starting at the download setting', async () => {
    const song = await downloaded()
    useQualityStore.getState().setDownloadFormat('flac')
    render(<Harness song={song} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    const formats = await within(dialog).findByRole('group', { name: 'Format' })
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('“Song 1” · downloaded as Opus · 150 kbps'),
    )
    const labels = within(formats)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent)
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

  it('asks where to save, converts with tags, writes the file and says so', async () => {
    const song = await downloaded()
    const saver = fakeSaver()
    setConverter(createInProcessConverter())
    const user = userEvent.setup()
    render(<Harness song={song} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    await user.click(await within(dialog).findByRole('radio', { name: /^FLAC/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await screen.findByText('closed')
    expect(saver.requests).toEqual([
      { fileName: 'Artist 1 - Song 1.flac', mimeType: 'audio/flac', description: 'FLAC audio' },
    ])
    const saved = new Uint8Array(await (saver.written[0] as Blob).arrayBuffer())
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
    const user = userEvent.setup()
    render(<Harness song={song} />)
    const dialog = await screen.findByRole('dialog', { name: 'Save to device' })
    await user.click(await within(dialog).findByRole('radio', { name: /^MP3/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
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
    render(<Harness song={song} />)
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
    render(<Harness song={song} />)
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
    render(<Harness song={track(9)} />)
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
