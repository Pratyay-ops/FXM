import type { NetworkCapabilities } from '@fxm/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TIER_CAPABILITIES, type Tier } from '../search/sources'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { FakeConnection, installConnection, removeConnection } from './fake-connection'
import { QualitySection } from './quality-section'
import { QUALITY_STORAGE_KEY, useQualityStore } from './quality-store'

afterEach(() => {
  removeConnection()
  resetCatalogState()
})

const LITE: NetworkCapabilities = {
  youtube: 'simple',
  mediaBytes: false,
  spotify: 'unreachable',
  fileSystem: false,
}
const FREE_ONLY: NetworkCapabilities = { ...LITE, youtube: 'none' }

const storedQuality = () => JSON.parse(localStorage.getItem(QUALITY_STORAGE_KEY) ?? 'null')

/** Finds the section's controls by name. */
function controls(section: HTMLElement) {
  return {
    select: (name: string) => within(section).getByRole('combobox', { name }),
    dataSaver: () => within(section).getByRole('switch', { name: 'Data saver' }),
  }
}

/** Renders Settings on the Full tier, or `tier`, and waits for the audio quality section. */
async function renderQuality(tier: Tier = 'full') {
  const rendered = renderCatalog('/settings', { tier })
  const section = await screen.findByRole('region', { name: 'Audio quality' })
  return { ...rendered, section, ...controls(section) }
}

/** Renders only the section, for a platform that reaches `capabilities`. */
function renderSection(capabilities: NetworkCapabilities) {
  const user = userEvent.setup()
  render(<QualitySection capabilities={capabilities} />)
  const section = screen.getByRole('region', { name: 'Audio quality' })
  return { user, section, ...controls(section) }
}

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

/** The live region among the elements that describe `control`. */
function liveHelpOf(control: HTMLElement): Element | null | undefined {
  return control
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id))
    .find((element) => element?.hasAttribute('aria-live'))
}

/**
 * Records changes inside live regions under `root` until the returned function is called, which
 * returns the regions whose text changed. Mounting or unmounting a region isn't such a change:
 * screen readers announce only what changes inside a region that was already there.
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

describe('Audio quality settings', () => {
  it('start with the data saver off, High on Wi-Fi, Normal on mobile data, original downloads', async () => {
    const { section, select, dataSaver } = await renderQuality()
    expect(dataSaver()).not.toBeChecked()
    expect(select('Streaming on Wi-Fi')).toHaveValue('high')
    expect(select('Streaming on mobile data')).toHaveValue('normal')
    expect(optionLabels(select('Streaming on Wi-Fi'))).toEqual([
      'Lossless',
      'High',
      'Normal',
      'Low',
    ])
    expect(select('Download format')).toHaveValue('original')
    expect(optionLabels(select('Download format'))).toEqual([
      'Original',
      'FLAC',
      'ALAC',
      'WAV',
      'MP3',
      'AAC',
      'Opus',
    ])
    expect(within(section).queryByRole('combobox', { name: 'MP3 bitrate' })).toBeNull()
  })

  it('put the data saver first, before the rows it overrides', async () => {
    const { section, dataSaver } = await renderQuality()
    const names = within(section)
      .getAllByRole('combobox')
      .map((control) => control.getAttribute('aria-labelledby'))
      .map((id) => (id ? document.getElementById(id)?.textContent : undefined))
    expect(names).toEqual([
      'Streaming on Wi-Fi',
      'Streaming on mobile data',
      'Quality to use',
      'Download format',
    ])
    const first = within(section).getAllByRole('combobox')[0] as HTMLElement
    expect(dataSaver().compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('saves the quality for each connection and says what it means', async () => {
    const { user, select } = await renderQuality()
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/the best YouTube audio/)

    await user.selectOptions(select('Streaming on Wi-Fi'), 'lossless')
    await user.selectOptions(select('Streaming on mobile data'), 'low')

    expect(useQualityStore.getState().prefs.streaming).toEqual({
      wifi: 'lossless',
      cellular: 'low',
    })
    expect(storedQuality()).toMatchObject({
      state: { prefs: { streaming: { wifi: 'lossless', cellular: 'low' } } },
    })
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(
      /YouTube audio is never lossless, so YouTube songs play at High/,
    )
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(/the least data/)
  })

  it('offer Automatic where the browser reports its connection, and tag the quality in use', async () => {
    const connection = new FakeConnection('wifi')
    installConnection(connection)
    const { select } = await renderQuality()
    const setting = select('Quality to use')
    expect(optionLabels(setting)).toEqual(['Automatic', 'Wi-Fi quality', 'Mobile data quality'])
    expect(setting).toHaveValue('auto')
    expect(setting).toHaveAccessibleDescription(
      "Automatic: you're on Wi-Fi, so FXM uses the Wi-Fi quality.",
    )
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/^High: .* In use$/)
    expect(select('Streaming on mobile data')).not.toHaveAccessibleDescription(/In use/)

    act(() => connection.change('cellular'))

    expect(setting).toHaveAccessibleDescription(
      "Automatic: you're on mobile data, so FXM uses the mobile data quality.",
    )
    expect(select('Streaming on Wi-Fi')).not.toHaveAccessibleDescription(/In use/)
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(/^Normal: .* In use$/)
  })

  it('let the user pick a quality over the detected connection', async () => {
    installConnection(new FakeConnection('wifi'))
    const { user, select } = await renderQuality()

    await user.selectOptions(select('Quality to use'), 'cellular')

    expect(useQualityStore.getState().streaming.connection).toBe('cellular')
    expect(storedQuality()).toMatchObject({ state: { streaming: { connection: 'cellular' } } })
    expect(select('Quality to use')).toHaveAccessibleDescription(
      /always uses the mobile data quality, for example on a phone's hotspot/,
    )
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(/ In use$/)
  })

  it('say where the browser can’t tell that mobile data needs choosing by hand', async () => {
    const { user, select } = await renderQuality()
    const setting = select('Quality to use')
    expect(optionLabels(setting)).toEqual(['Wi-Fi quality', 'Mobile data quality'])
    expect(setting).toHaveValue('wifi')
    expect(setting).toHaveAccessibleDescription(
      "This browser can't tell Wi-Fi from mobile data, so FXM uses the Wi-Fi quality. Switch to Mobile data quality when you're not on Wi-Fi, and back when you are.",
    )
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/ In use$/)
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(
      /applies only when you choose Mobile data quality below\.$/,
    )

    await user.selectOptions(setting, 'cellular')

    expect(useQualityStore.getState().streaming.connection).toBe('cellular')
    expect(setting).toHaveAccessibleDescription(
      /uses the mobile data quality until you switch back to Wi-Fi quality/,
    )
    expect(select('Streaming on Wi-Fi')).not.toHaveAccessibleDescription(/In use/)
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(/^Normal: .* In use$/)
    expect(select('Streaming on mobile data')).not.toHaveAccessibleDescription(/applies only/)
  })

  it('turn the data saver on with a switch, which overrides the streaming rows', async () => {
    const { user, section, select, dataSaver } = await renderQuality()
    expect(dataSaver()).toHaveAccessibleDescription(
      "Streams at Low on every connection and skips video streams when audio alone is available. Downloads aren't affected.",
    )

    await user.click(dataSaver())

    expect(dataSaver()).toBeChecked()
    expect(useQualityStore.getState().streaming.dataSaver).toBe(true)
    expect(storedQuality()).toMatchObject({ state: { streaming: { dataSaver: true } } })
    for (const name of ['Streaming on Wi-Fi', 'Streaming on mobile data', 'Quality to use']) {
      expect(select(name)).toBeDisabled()
      expect(select(name)).toHaveAccessibleDescription('Not used while Data saver is on.')
    }
    expect(within(section).queryByText('In use')).toBeNull()
    expect(select('Download format')).toBeEnabled()

    dataSaver().focus()
    await user.keyboard(' ')
    expect(dataSaver()).not.toBeChecked()
    expect(select('Streaming on Wi-Fi')).toBeEnabled()
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/^High: .* In use$/)
  })

  it('announce no help when the data saver turns on or off', async () => {
    const { user, section, dataSaver } = await renderQuality()
    const changed = watchLiveRegions(section)

    await user.click(dataSaver())
    await user.click(dataSaver())

    expect(changed()).toEqual([])
  })

  it('announce only the help of the setting that changed', async () => {
    installConnection(new FakeConnection('wifi'))
    const { user, section, select } = await renderQuality()
    const own = liveHelpOf(select('Streaming on Wi-Fi'))
    expect(own).toBeTruthy()
    const changed = watchLiveRegions(section)

    await user.selectOptions(select('Streaming on Wi-Fi'), 'lossless')

    const regions = changed()
    expect(regions.length).toBeGreaterThan(0)
    expect(new Set(regions)).toEqual(new Set([own]))
  })

  it('label conversions honestly: YouTube audio never becomes lossless', async () => {
    const { user, select } = await renderQuality()
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

  it('offer the MP3 bitrates for MP3 downloads, 320 kbps by default', async () => {
    const { user, section, select } = await renderQuality()

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

  it('follow a change saved in another tab', async () => {
    const { select } = await renderQuality()
    const saved = {
      prefs: {
        streaming: { wifi: 'high', cellular: 'high' },
        download: { format: 'mp3', mp3Kbps: 256 },
      },
      streaming: { connection: 'auto', dataSaver: false },
    }
    localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ state: saved, version: 1 }))

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: QUALITY_STORAGE_KEY }))
    })

    await waitFor(() => expect(select('Streaming on mobile data')).toHaveValue('high'))
    expect(select('MP3 bitrate')).toHaveValue('256')
  })
})

describe('Audio quality settings on other tiers and browsers', () => {
  it('follow the tier the platform reaches, also when it changes', async () => {
    const { select, platform } = await renderQuality('free')
    expect(select('Streaming on Wi-Fi')).not.toHaveAccessibleDescription(/YouTube/)

    // FXM Connect answered: the Full tier.
    act(() => platform.setCapabilities(TIER_CAPABILITIES.full))

    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/the best YouTube audio/)
  })

  it('say in Lite that downloads cover the free sources, and where YouTube songs download', () => {
    const { select } = renderSection(LITE)
    expect(select('Download format')).toHaveAccessibleDescription(
      'Saves each file as its source has it, with no conversion and no quality loss: FLAC, MP3 or Ogg Vorbis from Internet Archive and Jamendo. YouTube songs can be downloaded with FXM Connect, the desktop app or the Android app.',
    )
    // Lite still streams YouTube.
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(/the best YouTube audio/)
  })

  it('describe the tiers in bitrates, without YouTube, where it can’t be reached', () => {
    const { select } = renderSection(FREE_ONLY)
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(
      /High: the best lossy quality, such as MP3 at 256 kbps or more\./,
    )
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(
      /Normal: less data, such as MP3 at 128–255 kbps\./,
    )
    for (const name of ['Streaming on Wi-Fi', 'Streaming on mobile data']) {
      expect(select(name)).not.toHaveAccessibleDescription(/YouTube/)
    }
  })

  it('say where the browser can’t play Opus that Normal plays YouTube songs at Low', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
      type.includes('mp4a') ? 'probably' : '',
    )
    const { user, select } = renderSection(LITE)
    expect(select('Streaming on Wi-Fi')).toHaveAccessibleDescription(
      /High: the best YouTube audio this browser plays, AAC at about 130 kbps\./,
    )
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(
      /Normal: this browser can't play Opus, and YouTube has no AAC stream at Normal, so YouTube songs play at Low, AAC at about 50 kbps\./,
    )

    await user.selectOptions(select('Streaming on mobile data'), 'low')
    expect(select('Streaming on mobile data')).toHaveAccessibleDescription(
      /Low: the least data, AAC at about 50 kbps\./,
    )
  })
})
