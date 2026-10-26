import { ConvertError, type DeviceSaver, type SaveRequest } from '@fxm/convert'
import {
  createInProcessConverter,
  FakeFfmpegCore,
  readFlacBlocks,
  readVorbisComments,
} from '@fxm/convert/testing'
import type { Track } from '@fxm/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { track } from '../../../test/library-fixtures'
import { setLyricsProvider } from '../../lyrics/lyrics-source'
import { useFeedbackStore } from '../../search/feedback'
import { useQualityStore } from '../../settings/quality-store'
import { useSaveMenuItem } from '../menu'
import { setupDownloads } from '../testing'
import { setConverter, setDeviceSaver } from './save'
import { SaveToDeviceDialog } from './save-dialog'

/** A device saver that records what it is asked and what it writes. */
function fakeSaver(options: { cancel?: boolean } = {}) {
  const requests: SaveRequest[] = []
  const written: Blob[] = []
  const saver: DeviceSaver = {
    choose: async (request) => {
      requests.push(request)
      if (options.cancel) return undefined
      return {
        fileName: request.fileName,
        write: async (blob) => {
          written.push(blob)
        },
        discard: async () => {},
      }
    },
  }
  setDeviceSaver(saver)
  return { requests, written }
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

function Harness({ song }: { song: Track }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <p>{open ? 'open' : 'closed'}</p>
      <SaveToDeviceDialog track={open ? song : null} onClose={() => setOpen(false)} />
    </>
  )
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
