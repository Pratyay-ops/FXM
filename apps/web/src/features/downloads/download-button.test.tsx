import { downloadId, newDownloadRecord } from '@fxm/downloads'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { track } from '../../test/library-fixtures'
import { useQualityStore } from '../settings/quality-store'
import { DownloadButton } from './download-button'
import { useDownloadDialogStore } from './save/download-dialog-store'
import { fakeMediaUrl, setupDownloads } from './testing'

describe('the download button', { timeout: 30_000 }, () => {
  it('opens the Download dialog for the song', async () => {
    await setupDownloads()
    const user = userEvent.setup()
    render(<DownloadButton track={track(1)} />)
    await user.click(await screen.findByRole('button', { name: 'Download Song 1' }))
    expect(useDownloadDialogStore.getState().request).toMatchObject({ tracks: [track(1)] })
  })

  it('downloads a song, shows its progress, and removes the download after asking', async () => {
    // An offline copy only, as before Download saved files (Settings → Downloads).
    useQualityStore.getState().setSaveFile(false)
    const { downloads, server } = await setupDownloads()
    server.rule(fakeMediaUrl(track(1), 1), { holdAt: 1500 })
    const user = userEvent.setup()
    render(<DownloadButton track={track(1)} />)
    await user.click(await screen.findByRole('button', { name: 'Download Song 1' }))
    const running = await screen.findByRole('button', { name: 'Downloading Song 1, 34%. Pause' })
    await user.click(running)
    const paused = await screen.findByRole('button', {
      name: 'Download of Song 1 paused. Resume',
    })
    await user.click(paused)
    const done = await screen.findByRole('button', { name: 'Remove the download of Song 1' })
    await user.click(done)
    const dialog = await screen.findByRole('dialog', { name: 'Remove download?' })
    expect(within(dialog).getByText(/won’t play offline any more/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Remove the download of Song 1' }))
    await user.click(await screen.findByRole('button', { name: 'Remove download' }))
    expect(await screen.findByRole('button', { name: 'Download Song 1' })).toBeInTheDocument()
    await waitFor(async () => expect(await downloads.store.list()).toEqual([]))
  })

  it('waits its turn, and offers a retry after a failure', async () => {
    const { downloads, resolver } = await setupDownloads({ run: false })
    await downloads.manager.enqueue(track(1))
    const user = userEvent.setup()
    render(<DownloadButton track={track(1)} size="md" />)
    await user.click(
      await screen.findByRole('button', { name: 'Waiting to download Song 1. Pause' }),
    )
    expect(
      await screen.findByRole('button', { name: 'Download of Song 1 paused. Resume' }),
    ).toBeInTheDocument()
    const working = resolver.handler
    resolver.handler = () => {
      throw Object.assign(new Error('blocked'), { name: 'SecurityError' })
    }
    await downloads.manager.resume(downloadId(track(1)))
    await downloads.manager.start()
    const retry = await screen.findByRole('button', {
      name: 'Download of Song 1 failed. Try again',
    })
    resolver.handler = working
    await user.click(retry)
    expect(
      await screen.findByRole('button', { name: 'Remove the download of Song 1' }),
    ).toBeInTheDocument()
  })

  it('is not offered where the bytes are unreadable, yet still removes a download', async () => {
    const { downloads } = await setupDownloads({ tier: 'lite', run: false })
    const { container, rerender } = render(<DownloadButton track={track(1)} />)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(container).toBeEmptyDOMElement()
    const record = {
      ...newDownloadRecord(track(1), 1),
      status: 'completed' as const,
      file: 'kept',
      bytesDone: 3,
      bytesTotal: 3,
    }
    await downloads.store.update(record.id, () => record)
    rerender(<DownloadButton track={track(1)} />)
    expect(
      await screen.findByRole('button', { name: 'Remove the download of Song 1' }),
    ).toBeInTheDocument()
  })
})
