import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { FakeConnection, installConnection, removeConnection } from './fake-connection'
import { QUALITY_STORAGE_KEY, useQualityStore } from './quality-store'

afterEach(() => {
  removeConnection()
  useQualityStore.setState(useQualityStore.getInitialState(), true)
})

const storedQuality = () => JSON.parse(localStorage.getItem(QUALITY_STORAGE_KEY) ?? 'null')

/** Renders Settings and waits for the audio quality section. */
async function renderQuality() {
  const rendered = renderApp('/settings')
  const section = await screen.findByRole('region', { name: 'Audio quality' })
  const select = (name: string) => within(section).getByRole('combobox', { name })
  return { ...rendered, section, select }
}

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('Audio quality settings', () => {
  it('start at High on Wi-Fi and Normal on mobile data, data saver off, original downloads', async () => {
    const { section, select } = await renderQuality()
    expect(select('Streaming on Wi-Fi')).toHaveValue('high')
    expect(select('Streaming on mobile data')).toHaveValue('normal')
    expect(optionLabels(select('Streaming on Wi-Fi'))).toEqual([
      'Lossless',
      'High',
      'Normal',
      'Low',
    ])
    expect(within(section).getByRole('radio', { name: 'Off' })).toBeChecked()
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

  it('offers Automatic where the browser reports its connection, and follows it', async () => {
    const connection = new FakeConnection('wifi')
    installConnection(connection)
    const { select } = await renderQuality()
    const setting = select('Connection')
    expect(optionLabels(setting)).toEqual(['Automatic', 'Wi-Fi', 'Mobile data'])
    expect(setting).toHaveValue('auto')
    expect(setting).toHaveAccessibleDescription(
      "Automatic: you're on Wi-Fi, so FXM uses the Wi-Fi quality (High).",
    )

    act(() => connection.change('cellular'))

    expect(setting).toHaveAccessibleDescription(
      "Automatic: you're on mobile data, so FXM uses the mobile data quality (Normal).",
    )
  })

  it('lets the user pick a connection over the detected one', async () => {
    installConnection(new FakeConnection('wifi'))
    const { user, select } = await renderQuality()

    await user.selectOptions(select('Connection'), 'cellular')

    expect(useQualityStore.getState().streaming.connection).toBe('cellular')
    expect(storedQuality()).toMatchObject({ state: { streaming: { connection: 'cellular' } } })
    expect(select('Connection')).toHaveAccessibleDescription(
      /always uses the mobile data quality \(Normal\), for example on a phone's hotspot/,
    )
  })

  it('asks for the connection where the browser can’t tell', async () => {
    const { user, select } = await renderQuality()
    const setting = select('Connection')
    expect(optionLabels(setting)).toEqual(['Wi-Fi', 'Mobile data'])
    expect(setting).toHaveValue('wifi')
    expect(setting).toHaveAccessibleDescription(
      /doesn't say whether it's on Wi-Fi or mobile data, so FXM uses the Wi-Fi quality \(High\)/,
    )

    await user.selectOptions(setting, 'cellular')

    expect(useQualityStore.getState().streaming.connection).toBe('cellular')
    expect(setting).toHaveAccessibleDescription(
      /FXM uses the mobile data quality \(Normal\) until you choose Wi-Fi again/,
    )
  })

  it('turns the data saver on, which overrides the streaming quality', async () => {
    const { user, section, select } = await renderQuality()
    const on = within(section).getByRole('radio', { name: 'On' })
    expect(
      within(section).getByRole('radiogroup', { name: 'Data saver' }),
    ).toHaveAccessibleDescription(/checks only the stream it is about to play, not every format/)

    await user.click(on)

    expect(on).toBeChecked()
    expect(useQualityStore.getState().streaming.dataSaver).toBe(true)
    expect(storedQuality()).toMatchObject({ state: { streaming: { dataSaver: true } } })
    for (const name of ['Streaming on Wi-Fi', 'Streaming on mobile data', 'Connection']) {
      expect(select(name)).toBeDisabled()
      expect(select(name)).toHaveAccessibleDescription(
        'Data saver is on, so FXM streams at Low on every connection.',
      )
    }
    expect(select('Download format')).toBeEnabled()

    await user.click(within(section).getByRole('radio', { name: 'Off' }))
    expect(select('Streaming on Wi-Fi')).toBeEnabled()
  })

  it('labels conversions honestly: YouTube audio never becomes lossless', async () => {
    const { user, select } = await renderQuality()
    expect(select('Download format')).toHaveAccessibleDescription(
      /no conversion and no quality loss/,
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

  it('offers the MP3 bitrates for MP3 downloads, 320 kbps by default', async () => {
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

  it('shows what another tab or a restored backup saved', async () => {
    const { select } = await renderQuality()
    act(() => {
      useQualityStore.getState().setStreamingTier('cellular', 'high')
      useQualityStore.getState().setDownloadFormat('mp3')
      useQualityStore.getState().setMp3Bitrate(256)
    })
    expect(select('Streaming on mobile data')).toHaveValue('high')
    expect(select('MP3 bitrate')).toHaveValue('256')
  })
})
