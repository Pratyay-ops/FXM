import { isFxmError } from '@fxm/core'
import { webViewFileUrl } from '@fxm/player'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findFxmDeviceMusicPlugin } from './device-music'
import {
  DEVICE_READER_VERSION,
  deviceFormat,
  deviceNativeId,
  devicePath,
  deviceTags,
} from './device-scanner'
import { newTrackNativeId } from './ids'
import { resetLocalFiles } from './local-files'
import { createFakeDeviceMusic, deviceSong, installTestLocalFiles } from './testing'
import { DEVICE_ROOT_NAME } from './types'

afterEach(async () => {
  await resetLocalFiles()
})

/** The phone's music, listed: FXM allowed, its device root scanned. */
async function withDeviceMusic(songs = phoneSongs()) {
  const device = createFakeDeviceMusic(songs)
  const setup = await installTestLocalFiles({ deviceMusic: device })
  const result = await setup.files.addDeviceMusic()
  if (result.status === 'denied') throw new Error('denied')
  await setup.files.whenScanned(result.root.id)
  return { ...setup, device, root: result.root }
}

function phoneSongs() {
  return [
    deviceSong(11, 'Music/Aria Vale/Neon Rivers/01 Night Drive.flac', {
      title: 'Night Drive',
      artist: 'Aria Vale',
      album: 'Neon Rivers',
      albumId: '7',
      track: 1,
      mimeType: 'audio/flac',
      size: 25_000_000,
    }),
    deviceSong(12, 'Music/Aria Vale/Neon Rivers/02 Slow Tide.mp3', {
      title: 'Slow Tide',
      artist: 'Aria Vale',
      album: 'Neon Rivers',
      albumId: '7',
      track: 2,
      bitrate: 320_000,
    }),
    deviceSong(13, 'Download/voice.amr', { mimeType: 'audio/amr', title: 'A voice note' }),
  ]
}

describe('the device’s music (Android)', () => {
  it('is listed only after the user allowed it, from their click', async () => {
    const device = createFakeDeviceMusic(phoneSongs())
    device.covers.set('external_primary/7', btoa('cover of Neon Rivers'))
    const { files } = await installTestLocalFiles({ deviceMusic: device })
    expect(files.canListDeviceMusic()).toBe(true)
    // Checking the roots never asks.
    await files.checkRoots()
    expect(device.asked).toBe(0)
    const result = await files.addDeviceMusic()
    expect(device.asked).toBe(1)
    expect(result).toMatchObject({
      status: 'added',
      root: { kind: 'device', name: DEVICE_ROOT_NAME },
    })
    const outcome = await files.whenScanned(result.status === 'added' ? result.root.id : '')
    expect(outcome).toMatchObject({ status: 'done', added: 2, skipped: { unsupported: 1 } })
    const listed = await files.repo.listFiles()
    expect(listed.map((file) => file.tags.title).sort()).toEqual(['Night Drive', 'Slow Tide'])
    const flac = listed.find((file) => file.tags.title === 'Night Drive')
    expect(flac).toMatchObject({
      path: 'Music/Aria Vale/Neon Rivers/01 Night Drive.flac',
      uri: 'content://media/external_primary/audio/media/11',
      readerVersion: DEVICE_READER_VERSION,
      format: { codec: 'flac', container: 'flac', tier: 'lossless' },
      tags: { artists: ['Aria Vale'], album: 'Neon Rivers', trackNumber: 1, durationMs: 200_000 },
    })
    // One cover per album, kept as a picture both songs share.
    expect(device.albumsAsked).toEqual([{ volume: 'external_primary', id: '7', track: '11' }])
    const keys = new Set(listed.map((file) => file.pictureKey))
    expect(keys.size).toBe(1)
    const [key] = [...keys]
    const pictures = await files.repo.getPictures([key ?? ''])
    expect(pictures.get(key ?? '')?.url).toBe(
      `data:image/jpeg;base64,${btoa('cover of Neon Rivers')}`,
    )
  })

  it('says what the user refused, and never asks again on its own', async () => {
    const device = createFakeDeviceMusic(phoneSongs())
    device.answer = 'prompt-with-rationale'
    const { files } = await installTestLocalFiles({ deviceMusic: device })
    expect(await files.addDeviceMusic()).toEqual({ status: 'denied', forGood: false })
    device.access = 'prompt'
    device.answer = 'denied'
    expect(await files.addDeviceMusic()).toEqual({ status: 'denied', forGood: true })
    expect(await files.repo.listRoots()).toEqual([])
    await files.openDeviceSettings()
    expect(device.settingsOpened).toBe(1)
  })

  it('is scanned again once per visit while FXM may read it, and waits for the user otherwise', async () => {
    const { files, device, root, deps } = await withDeviceMusic()
    // The next visit: allowed still, so it is scanned again, with nothing new to write.
    const next = await resetLocalFiles(deps, { newVisit: true })
    await next.checkRoots()
    expect(await next.whenScanned(root.id)).toMatchObject({ unchanged: 2, added: 0, updated: 0 })
    // Access taken back in Android's settings: the songs stay listed, and FXM says what it needs.
    device.access = 'prompt'
    const later = await resetLocalFiles(deps, { newVisit: true })
    await later.checkRoots()
    expect(later.statusOf(root.id)).toEqual({ state: 'needs-access' })
    expect(device.asked).toBe(1)
    device.access = 'denied'
    const refused = await resetLocalFiles(deps, { newVisit: true })
    await refused.checkRoots()
    expect(refused.statusOf(root.id)).toEqual({ state: 'denied' })
    // Allow access from the root's button: Android asks, then FXM scans.
    device.access = 'prompt'
    expect(await refused.requestAccess(root.id)).toBe('granted')
    expect(device.asked).toBe(2)
    expect(await refused.whenScanned(root.id)).toMatchObject({ status: 'done' })
    expect(files.canListDeviceMusic()).toBe(true)
  })

  it('follows the songs: changed, gone, moved and on a memory card', async () => {
    const { files, device, root } = await withDeviceMusic()
    const before = await files.repo.listFiles()
    const idOf = (title: string) => before.find((file) => file.tags.title === title)?.id
    device.songs = [
      // Retagged: read again.
      {
        ...(device.songs[0] as (typeof device.songs)[number]),
        title: 'Night Drive (Remaster)',
        modifiedMs: 1_800_000_000_000,
      },
      // Moved to another folder: a new MediaStore item with the same size, length and tags.
      deviceSong(20, 'Music/Favourites/02 Slow Tide.mp3', {
        title: 'Slow Tide',
        artist: 'Aria Vale',
        album: 'Neon Rivers',
        albumId: '7',
        track: 2,
        bitrate: 320_000,
      }),
      deviceSong(21, 'Music/Card Song.mp3', { volume: '1234-abcd', title: 'Card Song' }),
    ]
    await files.rescan(root.id)
    const after = await files.repo.listFiles()
    expect(after.map((file) => file.tags.title).sort()).toEqual([
      'Card Song',
      'Night Drive (Remaster)',
      'Slow Tide',
    ])
    expect(after.find((file) => file.tags.title === 'Slow Tide')).toMatchObject({
      id: idOf('Slow Tide'),
      path: 'Music/Favourites/02 Slow Tide.mp3',
      uri: 'content://media/external_primary/audio/media/20',
    })
    expect(after.find((file) => file.tags.title.startsWith('Night'))?.id).toBe(idOf('Night Drive'))
    expect(after.find((file) => file.tags.title === 'Card Song')?.path).toBe(
      '1234-abcd/Music/Card Song.mp3',
    )
  })

  it('reads in pages, and a scan stopped halfway removes nothing', async () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      deviceSong(index + 1, `Music/Song ${index + 1}.mp3`, { title: `Song ${index + 1}` }),
    )
    const { files, device, root } = await withDeviceMusic(many)
    expect(await files.repo.countFiles(root.id)).toBe(5)
    device.songs = []
    const release = device.hold()
    const scan = files.rescan(root.id)
    await vi.waitFor(() => expect(files.statusOf(root.id).state).toBe('scanning'))
    files.cancelScan(root.id)
    release()
    await scan
    expect(await files.repo.countFiles(root.id)).toBe(5)
  })

  it('plays a song from its MediaStore URI, asking for access from the click when needed', async () => {
    const { files, device } = await withDeviceMusic()
    const flac = (await files.repo.listFiles()).find((file) => file.tags.title === 'Night Drive')
    const stream = await files.streamFor(flac?.id ?? '')
    expect(stream).toMatchObject({
      url: webViewFileUrl('content://media/external_primary/audio/media/11'),
      codec: 'flac',
      tier: 'lossless',
      fullLength: 'verified',
      ipBound: false,
    })
    expect(stream.url).toBe(
      `${window.location.origin}/_capacitor_content_/media/external_primary/audio/media/11`,
    )
    // Access taken back: playing asks again, and a refusal says what to do.
    device.access = 'prompt'
    device.answer = 'denied'
    const refused = await files.streamFor(flac?.id ?? '').catch((error: unknown) => error)
    expect(isFxmError(refused, 'AuthRequired')).toBe(true)
    expect(device.asked).toBe(2)
  })

  it('is not offered outside the Android app', async () => {
    const { files } = await installTestLocalFiles()
    expect(files.canListDeviceMusic()).toBe(false)
    await expect(files.addDeviceMusic()).rejects.toMatchObject({ code: 'Unsupported' })
    expect(findFxmDeviceMusicPlugin({})).toBeUndefined()
    const device = createFakeDeviceMusic()
    expect(
      findFxmDeviceMusicPlugin({
        Capacitor: { isNativePlatform: () => true, Plugins: { FxmDeviceMusic: device } },
      }),
    ).toBe(device)
    expect(
      findFxmDeviceMusicPlugin({
        Capacitor: { isNativePlatform: () => false, Plugins: { FxmDeviceMusic: device } },
      }),
    ).toBeUndefined()
  })
})

describe('a song’s format, tags and ID from MediaStore', () => {
  it('maps the MIME types MediaStore gives, lossless only for FLAC and WAV', () => {
    const song = (mimeType: string | undefined, path = 'Music/a.mp3') =>
      deviceFormat({ ...deviceSong(1, path), ...(mimeType === undefined ? {} : { mimeType }) })
    expect(song('audio/mpeg')).toMatchObject({ codec: 'mp3', container: 'mp3' })
    expect(song('audio/flac', 'Music/a.flac')).toMatchObject({ codec: 'flac', tier: 'lossless' })
    expect(song('audio/x-wav', 'Music/a.wav')).toMatchObject({ codec: 'pcm', tier: 'lossless' })
    // MediaStore can't tell ALAC from AAC: never lossless when it might not be.
    expect(song('audio/mp4', 'Music/a.m4a')).toMatchObject({ codec: 'aac', container: 'm4a' })
    expect(song('audio/mp4', 'Music/a.mp4')).toMatchObject({ codec: 'aac', container: 'mp4' })
    expect(song('audio/ogg', 'Music/a.opus')).toMatchObject({ codec: 'opus', container: 'ogg' })
    expect(song('audio/ogg', 'Music/a.ogg')).toMatchObject({ codec: 'vorbis', container: 'ogg' })
    expect(song('audio/webm', 'Music/a.webm')).toMatchObject({ codec: 'opus', container: 'webm' })
    // Without a MIME type, the extension.
    expect(
      deviceFormat({ ...deviceSong(1, 'Music/a.flac'), mimeType: undefined } as never),
    ).toMatchObject({
      codec: 'flac',
    })
    for (const unsupported of ['audio/amr', 'audio/aac', 'audio/midi', 'audio/x-ms-wma']) {
      expect(song(unsupported)).toBeUndefined()
    }
  })

  it('takes the bitrate MediaStore knows, else the size over the length', () => {
    expect(deviceFormat(deviceSong(1, 'a.mp3', { bitrate: 320_000 }))?.bitrateKbps).toBe(320)
    // 4,000,000 bytes over 200 s: 160 kbps.
    expect(deviceFormat(deviceSong(1, 'a.mp3'))?.bitrateKbps).toBe(160)
    expect(
      deviceFormat(
        deviceSong(1, 'a.flac', { mimeType: 'audio/flac', bitsPerSample: 24, sampleRate: 96_000 }),
      ),
    ).toMatchObject({ bitDepth: 24, sampleRateHz: 96_000 })
    expect(deviceFormat(deviceSong(1, 'a.mp3', { bitsPerSample: 16 }))).not.toHaveProperty(
      'bitDepth',
    )
  })

  it('cleans MediaStore’s tags, with the file name for a song without a title', () => {
    expect(deviceTags(deviceSong(1, 'Music/A/03 - Untitled Jam.mp3'))).toEqual({
      title: 'Untitled Jam',
      artists: [],
      trackNumber: 3,
      durationMs: 200_000,
    })
    expect(
      deviceTags(
        deviceSong(1, 'a.mp3', {
          title: '  Song\u0000 ',
          artist: 'Band',
          albumArtist: 'Various',
          album: 'Hits',
          disc: 2,
          track: 4,
          year: 1999,
          compilation: true,
        }),
      ),
    ).toEqual({
      title: 'Song',
      artists: ['Band'],
      albumArtist: 'Various',
      album: 'Hits',
      trackNumber: 4,
      discNumber: 2,
      releaseDate: '1999',
      compilation: true,
      durationMs: 200_000,
    })
  })

  it('gives a song in the Music folder the ID a web folder scan gives it', () => {
    const path = 'Music/Aria Vale/Neon Rivers/01 Night Drive.flac'
    expect(deviceNativeId(path, new Set())).toBe(
      newTrackNativeId('Music', 'Aria Vale/Neon Rivers/01 Night Drive.flac'),
    )
    expect(devicePath({ volume: 'external_primary', path })).toBe(path)
    expect(devicePath({ volume: '1234-abcd', path })).toBe(`1234-abcd/${path}`)
    const taken = new Set([deviceNativeId(path, new Set())])
    expect(deviceNativeId(path, taken)).not.toBe([...taken][0])
  })
})
