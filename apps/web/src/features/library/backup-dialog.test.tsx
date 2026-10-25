import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BACKUP_FORMAT } from '../../db/backup'
import { getLibrary } from '../../db/repo'
import { LIKED_PLAYLIST_ID } from '../../db/types'
import { track, tracks } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { useSettingsStore } from '../settings/settings-store'

const main = () => within(screen.getByRole('main'))

/** Catches the file the page saves through a download link. */
function catchDownloads() {
  const files: { name: string; blob: Blob }[] = []
  let pending: Blob | undefined
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    pending = blob as Blob
    return 'blob:fxm-backup'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pending) files.push({ name: this.download, blob: pending })
  })
  return files
}

/** The text of the one file saved so far. */
async function savedText(files: { blob: Blob }[]): Promise<string> {
  const [file] = files
  if (!file) throw new Error('Nothing was saved')
  return file.blob.text()
}

describe('Backup dialog', { timeout: 30_000 }, () => {
  it('downloads a backup, and restores it into an emptied library', async () => {
    const library = getLibrary()
    const mix = await library.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await library.moveItems(mix, [track(3).id], 'top')
    await library.like(track(1))
    useSettingsStore.getState().setTheme('light')
    const files = catchDownloads()
    const { user } = renderApp('/library')

    await user.click(await main().findByRole('button', { name: 'Backup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Back up your library' })
    expect(within(dialog).getByText(/This browser has no backup yet/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Download backup' }))

    await waitFor(() => expect(files).toHaveLength(1))
    expect(files[0]?.name).toMatch(/^fxm-library-\d{4}-\d{2}-\d{2}\.json$/)
    const text = await savedText(files)
    expect(JSON.parse(text)).toMatchObject({
      format: BACKUP_FORMAT,
      appSettings: { catalogMode: 'music', theme: 'light' },
    })
    expect(within(dialog).getByText(/Last backup from this browser: today/)).toBeInTheDocument()

    // Everything goes, settings included…
    await library.clearLibrary()
    useSettingsStore.getState().setTheme('dark')

    // …and comes back from the file.
    await user.upload(
      within(dialog).getByLabelText('Choose a backup file'),
      new File([text], 'fxm-library.json', { type: 'application/json' }),
    )
    expect(
      await within(dialog).findByText('1 playlist · 1 liked song · 0 follows · 0 plays'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Replace/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Replace my library' }))

    expect(await screen.findByText('Library replaced from the backup')).toBeInTheDocument()
    expect(await library.getOrder(mix)).toEqual([3, 1, 2].map((n) => track(n).id))
    expect(await library.getOrder(LIKED_PLAYLIST_ID)).toEqual([track(1).id])
    expect(useSettingsStore.getState().theme).toBe('light')
  })

  it('merges a backup without removing what is here', async () => {
    const library = getLibrary()
    await library.createPlaylist({ name: 'From the backup' })
    const files = catchDownloads()
    const { user } = renderApp('/library')
    await user.click(await main().findByRole('button', { name: 'Backup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Back up your library' })
    await user.click(within(dialog).getByRole('button', { name: 'Download backup' }))
    await waitFor(() => expect(files).toHaveLength(1))
    const text = await savedText(files)

    await library.clearLibrary()
    await library.createPlaylist({ name: 'Made here' })
    await user.upload(
      within(dialog).getByLabelText('Choose a backup file'),
      new File([text], 'backup.json', { type: 'application/json' }),
    )
    // Merge is the default.
    await user.click(await within(dialog).findByRole('button', { name: 'Merge into my library' }))

    expect(await screen.findByText('Backup merged into your library')).toBeInTheDocument()
    const names = (await library.getPlaylistList()).items.map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['Made here', 'From the backup']))
  })

  it('explains why a file is refused', async () => {
    const { user } = renderApp('/library')
    await user.click(await main().findByRole('button', { name: 'Backup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Back up your library' })
    const input = within(dialog).getByLabelText('Choose a backup file')

    await user.upload(input, new File(['not json'], 'notes.json', { type: 'application/json' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/can’t be read as JSON/)

    await user.upload(
      input,
      new File([JSON.stringify({ format: BACKUP_FORMAT, version: 99, tables: {} })], 'new.json', {
        type: 'application/json',
      }),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/newer version of FXM/)
    expect(within(dialog).queryByRole('button', { name: /my library/ })).not.toBeInTheDocument()
  })
})
