import { FakeEngine } from '@fxm/player/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { resetLocalFiles } from './local-files'
import { configureLocalPlayer, resetLocalPlayer } from './player'
import { createFakeDeviceMusic, deviceSong, installTestLocalFiles } from './testing'

let engine: FakeEngine

beforeEach(() => {
  engine = new FakeEngine()
  configureLocalPlayer({ engine, mediaSession: false })
})

afterEach(async () => {
  resetLocalPlayer()
  await resetLocalFiles()
})

function phone() {
  return createFakeDeviceMusic([
    deviceSong(11, 'Music/Aria Vale/01 Night Drive.flac', {
      title: 'Night Drive',
      artist: 'Aria Vale',
      mimeType: 'audio/flac',
    }),
    deviceSong(12, 'Music/Aria Vale/02 Slow Tide.mp3', { title: 'Slow Tide', artist: 'Aria Vale' }),
    deviceSong(13, 'Recordings/memo.amr', { mimeType: 'audio/amr' }),
  ])
}

describe('the device’s music in the Local files tab (Android)', () => {
  it('is listed from the user’s click, after they allowed it', async () => {
    const device = phone()
    const { files } = await installTestLocalFiles({ deviceMusic: device })
    const { user } = renderApp('/library?tab=local')
    expect(
      await screen.findByText(
        /Show the music on this device\. FXM lists the songs your phone knows/,
      ),
    ).toBeVisible()
    expect(device.asked).toBe(0)
    // Chosen files would play from object URLs, which the app's native player can't read.
    expect(screen.queryByRole('button', { name: /^Choose/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /folder/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Music on this device' }))
    const [root] = await files.repo.listRoots()
    await files.whenScanned(root?.id ?? '')
    expect(device.asked).toBe(1)
    const list = await screen.findByRole('list', { name: 'Songs in local files' })
    expect(within(list).getByText('Night Drive')).toBeInTheDocument()
    expect(within(list).getByText('Slow Tide')).toBeInTheDocument()
    const sources = screen.getByRole('region', { name: 'Where your music comes from' })
    expect(within(sources).getByText('This device')).toBeVisible()
    expect(
      within(sources).getByText(/^2 songs · updated .* · 1 file can’t be played here$/),
    ).toBeVisible()
    expect(
      await screen.findByText('Added 2 songs on this device. 1 file can’t be played here'),
    ).toBeVisible()
    // Listed once, nothing is left to add: no "Add music".
    expect(screen.queryByRole('button', { name: 'Add music' })).toBeNull()
  })

  it('plays a song from the device', async () => {
    const device = phone()
    const { files } = await installTestLocalFiles({ deviceMusic: device })
    const result = await files.addDeviceMusic()
    if (result.status === 'denied') throw new Error('denied')
    await files.whenScanned(result.root.id)
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Play Night Drive' }))
    await waitFor(() =>
      expect(engine.source?.stream.url).toBe(
        `${window.location.origin}/_capacitor_content_/media/external_primary/audio/media/11`,
      ),
    )
  })

  it('says what a refusal means, and leads to Android’s settings', async () => {
    const device = phone()
    const { files } = await installTestLocalFiles({ deviceMusic: device })
    const result = await files.addDeviceMusic()
    if (result.status === 'denied') throw new Error('denied')
    await files.whenScanned(result.root.id)
    // Taken back for good in Android's settings.
    device.access = 'denied'
    await files.checkRoots()
    const { user } = renderApp('/library?tab=local')
    const sources = await screen.findByRole('region', { name: 'Where your music comes from' })
    expect(
      await within(sources).findByText(
        'You didn’t let FXM see your music. Allow it in Android’s settings',
      ),
    ).toBeVisible()
    await user.click(within(sources).getByRole('button', { name: 'Open settings: This device' }))
    expect(device.settingsOpened).toBe(1)
    // Its songs can't play until then, and say why.
    const list = await screen.findByRole('list', { name: 'Songs in local files' })
    expect(within(list).getAllByText('No access').length).toBeGreaterThan(0)
  })

  it('asks again only from the user’s click, after a refusal Android may still ask about', async () => {
    const device = phone()
    device.answer = 'prompt'
    await installTestLocalFiles({ deviceMusic: device })
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Music on this device' }))
    expect(
      await screen.findByText('FXM needs your permission to show the music on this device'),
    ).toBeVisible()
    expect(device.asked).toBe(1)
  })
})
