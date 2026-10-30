import type { NetworkCapabilities } from '@fxm/core'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASED } from '../connect/config'
import { INITIAL_CONNECTION, useConnection } from '../connect/connection'
import { setDeviceSaver } from '../downloads/save/save'
import { TIER_CAPABILITIES } from '../search/sources'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { DownloadsSection } from './downloads-section'
import { QUALITY_STORAGE_KEY, useQualityStore } from './quality-store'

afterEach(() => {
  resetCatalogState()
  useConnection.setState(INITIAL_CONNECTION, true)
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
})

const FULL: NetworkCapabilities = TIER_CAPABILITIES.full
const LITE: NetworkCapabilities = {
  youtube: 'simple',
  mediaBytes: false,
  spotify: 'unreachable',
  fileSystem: false,
}

const SAVE_FILE = 'Save a file to this device when downloading'
const DOWNLOAD_NOTE =
  'FXM keeps the original file to play offline. The file Download saves, and “Save to device…”, start at this format; you can pick another each time.'
const SAVE_LATER_NOTE =
  'Downloads keep the original file, which plays offline as it is. A downloaded song’s “Save to device…” starts at this format.'

const storedQuality = () => JSON.parse(localStorage.getItem(QUALITY_STORAGE_KEY) ?? 'null')

/** Finds the section's controls by name. */
function controls(section: HTMLElement) {
  return {
    select: (name: string) => within(section).getByRole('combobox', { name }),
    saveFile: () => within(section).getByRole('switch', { name: SAVE_FILE }),
  }
}

/**
 * Renders only the section, for a platform that reaches `capabilities`, with conversions
 * (stage 4.2) as released unless `conversions` says otherwise.
 */
function renderSection(
  capabilities: NetworkCapabilities,
  { conversions = RELEASED.conversions }: { conversions?: boolean } = {},
) {
  const user = userEvent.setup()
  render(<DownloadsSection capabilities={capabilities} conversions={conversions} />)
  const section = screen.getByRole('region', { name: 'Downloads' })
  return { user, section, ...controls(section) }
}

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

/**
 * Records changes inside live regions under `root` until the returned function is called, which
 * returns the regions whose text changed.
 */
function watchLiveRegions(root: HTMLElement): () => Element[] {
  const records: MutationRecord[] = []
  const observer = new MutationObserver((batch) => records.push(...batch))
  observer.observe(root, { subtree: true, childList: true, characterData: true })
  return () => {
    records.push(...observer.takeRecords())
    observer.disconnect()
    return records.flatMap(({ target }) => {
      const element = target instanceof Element ? target : target.parentElement
      const region = element?.closest('[aria-live]')
      return region ? [region] : []
    })
  }
}

describe('Download settings', () => {
  it('sit in Settings after Audio quality: save a file on, original format', async () => {
    renderCatalog('/settings', { tier: 'full' })
    const section = await screen.findByRole('region', { name: 'Downloads' })
    const { select, saveFile } = controls(section)
    expect(saveFile()).toBeChecked()
    expect(select('Download format')).toHaveValue('original')
    // Conversions are out (stage 4.2): every format can be chosen.
    expect(optionLabels(select('Download format'))).toEqual([
      'Original',
      'FLAC',
      'ALAC',
      'WAV',
      'MP3',
      'AAC',
      'Opus',
    ])
    const options = within(select('Download format')).getAllByRole('option')
    expect(options.filter((option) => (option as HTMLOptionElement).disabled)).toEqual([])
    expect(select('Download format')).toHaveAccessibleDescription(new RegExp(`${DOWNLOAD_NOTE}$`))
    expect(within(section).queryByRole('combobox', { name: 'MP3 bitrate' })).toBeNull()
    // The switch first, then the format it uses.
    const quality = screen.getByRole('region', { name: 'Audio quality' })
    expect(quality.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(
      saveFile().compareDocumentPosition(select('Download format')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('say that Download saves the file to the browser’s downloads, where it has no picker', () => {
    const { saveFile } = renderSection(FULL)
    expect(saveFile()).toHaveAccessibleDescription(
      'Download asks for the format, then keeps the song in FXM to play offline and saves its file to your browser’s downloads.',
    )
  })

  it('say that Download asks where to save, where the browser has a save picker', () => {
    // Chromium on desktop.
    ;(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {}
    const { saveFile } = renderSection(FULL)
    expect(saveFile()).toHaveAccessibleDescription(
      'Download asks for the format and where to save, then keeps the song in FXM to play offline and saves its file there. An album or a playlist goes into a folder you pick.',
    )
  })

  it('turn saving a file off: Download keeps the copy in FXM, and Save to device saves later', async () => {
    const { user, section, select, saveFile } = renderSection(FULL)
    const own = saveFile()
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id))
      .find((element) => element?.hasAttribute('aria-live'))
    expect(own).toBeTruthy()
    const changed = watchLiveRegions(section)

    await user.click(saveFile())

    expect(saveFile()).not.toBeChecked()
    expect(useQualityStore.getState().downloads.saveFile).toBe(false)
    expect(storedQuality()).toMatchObject({ state: { downloads: { saveFile: false } } })
    expect(saveFile()).toHaveAccessibleDescription(
      'Download keeps the song in FXM only, where it plays offline. To get a file, use “Save to device…” in a downloaded song’s menu.',
    )
    expect(select('Download format')).toHaveAccessibleDescription(new RegExp(`${SAVE_LATER_NOTE}$`))
    // Only the switch's own help is announced, not the format's.
    expect(new Set(changed())).toEqual(new Set([own]))
  })

  it('say where no file can be saved, with the switch off and disabled', () => {
    // The Android app, before it has a saver of its own.
    useConnection.setState({ platform: 'android' })
    const { select, saveFile } = renderSection(FULL)
    expect(saveFile()).toBeDisabled()
    expect(saveFile()).not.toBeChecked()
    expect(saveFile()).toHaveAccessibleDescription(
      'The Android app can’t save files yet, so Download keeps each song in FXM, where it plays offline.',
    )
    expect(select('Download format')).toHaveAccessibleDescription(
      /This app can’t save files yet, so the format waits until it can\.$/,
    )
    // Once the app sets its own saver, it can.
    act(() =>
      setDeviceSaver({
        choose: async () => undefined,
      }),
    )
    expect(saveFile()).toBeEnabled()
    expect(saveFile()).toBeChecked()
    expect(saveFile()).toHaveAccessibleDescription(/saves its file on this device\.$/)
  })

  it('keep a format chosen before, with its MP3 bitrate', async () => {
    useQualityStore.getState().setDownloadFormat('mp3')
    const { section, select } = renderSection(FULL)

    expect(select('Download format')).toHaveValue('mp3')
    expect(within(section).getByRole('combobox', { name: 'MP3 bitrate' })).toHaveValue('320')
  })

  it('offer only Original, the rest as coming soon, while conversions are off', () => {
    useQualityStore.getState().setDownloadFormat('mp3')
    const { section, select } = renderSection(FULL, { conversions: false })

    // Whatever was chosen before, Download and Save to device start at the original then.
    expect(select('Download format')).toHaveValue('original')
    expect(optionLabels(select('Download format'))).toEqual([
      'Original',
      'FLAC (coming soon)',
      'ALAC (coming soon)',
      'WAV (coming soon)',
      'MP3 (coming soon)',
      'AAC (coming soon)',
      'Opus (coming soon)',
    ])
    const options = within(select('Download format')).getAllByRole('option')
    expect(options.filter((option) => (option as HTMLOptionElement).disabled)).toHaveLength(6)
    expect(select('Download format')).toHaveAccessibleDescription(
      new RegExp(`is coming soon\\. ${DOWNLOAD_NOTE}$`),
    )
    expect(within(section).queryByRole('combobox', { name: 'MP3 bitrate' })).toBeNull()
  })

  it('label conversions honestly: YouTube audio never becomes lossless', async () => {
    const { user, select } = renderSection(FULL)
    expect(select('Download format')).toHaveAccessibleDescription(
      /no conversion and no quality loss: Opus or AAC for YouTube songs/,
    )

    await user.selectOptions(select('Download format'), 'flac')

    expect(useQualityStore.getState().prefs.download.format).toBe('flac')
    const description = select('Download format')
    expect(description).toHaveAccessibleDescription(
      /A YouTube song in Opus: FLAC \(converted from Opus, same quality as the source\)\./,
    )
    expect(description).toHaveAccessibleDescription(
      /A lossless source in FLAC: FLAC \(no conversion\)\./,
    )
    expect(description).toHaveAccessibleDescription(/YouTube audio is never lossless/)

    await user.selectOptions(select('Download format'), 'opus')
    expect(select('Download format')).toHaveAccessibleDescription(
      /A YouTube song in Opus: Opus \(no conversion\)\. A lossless source in FLAC: Opus \(converted from FLAC, some quality loss\)\./,
    )
    expect(select('Download format')).not.toHaveAccessibleDescription(/never lossless/)
  })

  it('offer the MP3 bitrates for MP3, 320 kbps by default', async () => {
    const { user, section, select } = renderSection(FULL)

    await user.selectOptions(select('Download format'), 'mp3')

    const bitrate = select('MP3 bitrate')
    expect(bitrate).toHaveValue('320')
    expect(optionLabels(bitrate)).toEqual(['128 kbps', '192 kbps', '256 kbps', '320 kbps'])
    expect(bitrate).toHaveAccessibleDescription(/No bitrate adds quality the source doesn't have/)

    await user.selectOptions(bitrate, '192')

    expect(useQualityStore.getState().prefs.download).toEqual({ format: 'mp3', mp3Kbps: 192 })
    expect(storedQuality()).toMatchObject({
      state: { prefs: { download: { format: 'mp3', mp3Kbps: 192 } } },
    })

    await user.selectOptions(select('Download format'), 'original')
    expect(within(section).queryByRole('combobox', { name: 'MP3 bitrate' })).toBeNull()
  })

  it('say in Lite that downloads cover the free sources, and where YouTube songs download', () => {
    const { select } = renderSection(LITE)
    expect(select('Download format')).toHaveAccessibleDescription(
      `Saves each file as its source has it, with no conversion and no quality loss: FLAC, MP3 or Ogg Vorbis from Internet Archive. YouTube songs can be downloaded with FXM Connect. ${DOWNLOAD_NOTE}`,
    )
  })
})
