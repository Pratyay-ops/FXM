import { isFxmError } from '@fxm/core'
import { NativeEngine, type ResolveRequest, webViewFileUrl } from '@fxm/player'
import { createFakeFxmPlayer, testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configurePlayback } from '../now-playing/playback'
import { FakePolicy } from '../now-playing/testing'
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
import { withLocalFiles, withLocalFilesFirst } from './player'
import { createFakeDeviceMusic, deviceSong, installTestLocalFiles } from './testing'
import { toTrack } from './tracks'
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
    const stream = await files.streamFor(flac?.id ?? '', { ask: true })
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
    const refused = await files.streamFor(flac?.id ?? '', { ask: true }).catch((error) => error)
    expect(isFxmError(refused, 'AuthRequired')).toBe(true)
    expect(device.asked).toBe(2)
  })

  it('asks for access only when the user asked for the song', async () => {
    const { files, device, root } = await withDeviceMusic()
    const flac = (await files.repo.listFiles()).find((file) => file.tags.title === 'Night Drive')
    // Taken back in Android's settings, or reset after months unused.
    device.access = 'prompt'
    const error = await files.streamFor(flac?.id ?? '').catch((failure: unknown) => failure)
    expect(isFxmError(error, 'AuthRequired')).toBe(true)
    expect((error as Error).message).toBe(
      'Allow FXM to see the music on this device to play this song',
    )
    expect(device.asked).toBe(1)
    expect(files.statusOf(root.id)).toEqual({ state: 'needs-access' })
    // Allowed meanwhile, it plays without asking.
    device.access = 'granted'
    expect((await files.streamFor(flac?.id ?? '')).codec).toBe('flac')
    expect(device.asked).toBe(1)
  })

  it('adds no folders or chosen files in the Android app, whose player can’t play them', async () => {
    const { files } = await installTestLocalFiles({ deviceMusic: createFakeDeviceMusic() })
    expect(files.canAddFiles()).toBe(false)
    const chosen = new File([new Uint8Array(4)], 'a.mp3', { type: 'audio/mpeg' })
    await expect(files.addPicked([chosen])).rejects.toMatchObject({
      code: 'Unsupported',
      message: 'Songs you choose play in a browser. In the app, add the music on this device',
    })
    await expect(files.addFolder()).rejects.toMatchObject({ code: 'Unsupported' })
    expect(await files.repo.listRoots()).toEqual([])
  })

  it('is not offered outside the Android app', async () => {
    const { files } = await installTestLocalFiles()
    expect(files.canListDeviceMusic()).toBe(false)
    expect(files.canAddFiles()).toBe(true)
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

/** Lets pending promises and zero-delay timers run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('the device’s music in the player (Android)', () => {
  /** "Slow Tide" from the phone, listed, as a track; FXM's access then taken back. */
  async function revokedSong() {
    const setup = await withDeviceMusic()
    const file = (await setup.files.repo.listFiles()).find(
      (song) => song.tags.title === 'Slow Tide',
    )
    if (file === undefined) throw new Error('Slow Tide is not listed')
    // Taken back in Android's settings, or reset after months unused.
    setup.device.access = 'prompt'
    return { ...setup, track: toTrack(file) }
  }

  function request(overrides: Partial<ResolveRequest>): ResolveRequest {
    return {
      reason: 'play',
      attempt: 0,
      signal: new AbortController().signal,
      canPlay: () => 'probably',
      ...overrides,
    }
  }

  it('asks for access for a song the user played, never for a preload or the queue moving on', async () => {
    const { files, device, track } = await revokedSong()
    const resolver = withLocalFiles({ resolve: vi.fn() }, () => files)
    for (const quiet of [
      { reason: 'preload', explicit: false },
      { reason: 'play', explicit: false },
      { reason: 'retry', explicit: false },
      { reason: 'play' },
      { reason: 'preload', explicit: true },
    ] as const) {
      const error = await resolver
        .resolve({ uid: 1, track }, request(quiet))
        .catch((failure: unknown) => failure)
      expect(isFxmError(error, 'AuthRequired'), JSON.stringify(quiet)).toBe(true)
    }
    expect(device.asked).toBe(1)
    const played = await resolver.resolve(
      { uid: 1, track },
      request({ reason: 'play', explicit: true }),
    )
    expect(device.asked).toBe(2)
    expect(played.stream.url).toBe(
      webViewFileUrl('content://media/external_primary/audio/media/12'),
    )
  })

  it('never asks while Media3’s queue fills up or the queue moves on: Play does', async () => {
    const { files, device, track } = await revokedSong()
    const plugin = createFakeFxmPlayer()
    const playback = configurePlayback({
      createEngine: () => new NativeEngine({ plugin, origin: window.location.origin }),
      policy: withLocalFilesFirst(new FakePolicy(), () => files),
      mediaSession: false,
      recordPlays: false,
      player: { retryDelaysMs: [0], stallTimeoutMs: 0 },
    })
    await playback.ready
    await playback.player.setQueue([testTrack('Remote'), track])
    await vi.waitFor(() =>
      expect(plugin.calls.some((call) => call.startsWith('load:Remote'))).toBe(true),
    )
    await settle()
    // The native engine resolved the phone's song ahead, for Media3's queue: nothing asked.
    expect(device.asked).toBe(1)
    // Moving on to it stops the player with what to do, without asking either.
    await playback.player.next()
    await vi.waitFor(() => expect(playback.player.getState().status).toBe('error'))
    expect(playback.player.getState().error?.error.message).toBe(
      'Allow FXM to see the music on this device to play this song',
    )
    expect(device.asked).toBe(1)
    // Play, the user's own action, asks; allowed, the song plays from the device.
    await playback.player.play()
    await vi.waitFor(() => expect(device.asked).toBe(2))
    await vi.waitFor(() =>
      expect(plugin.calls.some((call) => call.startsWith('load:Slow Tide'))).toBe(true),
    )
  })
})

describe('a song’s format, tags and ID from MediaStore', () => {
  const song = (mimeType: string | undefined, path = 'Music/a.mp3') =>
    deviceFormat({ ...deviceSong(1, path), ...(mimeType === undefined ? {} : { mimeType }) })

  it('maps the MIME types MediaStore gives, lossless only for FLAC and WAV', () => {
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
    for (const [unsupported, path] of [
      ['audio/amr', 'Recordings/memo.amr'],
      ['audio/aac', 'Music/raw.aac'],
      ['audio/midi', 'Music/tune.mid'],
      ['audio/x-ms-wma', 'Music/old.wma'],
      ['audio/3gpp', 'Music/clip.3gp'],
    ] as const) {
      expect(song(unsupported, path)).toBeUndefined()
    }
  })

  it('lists the copies FXM saved to Music/FXM, as Media3 plays them', () => {
    // Opus from YouTube, saved as Matroska audio.
    expect(song('audio/x-matroska', 'Music/FXM/Radiohead - Creep.mka')).toMatchObject({
      codec: 'opus',
      container: 'webm',
    })
    // FLAC in Ogg is lossless where FXM saved it; elsewhere an .oga may be Vorbis.
    expect(song('audio/ogg', 'Music/FXM/Aria Vale - Night Drive.oga')).toMatchObject({
      codec: 'flac',
      container: 'ogg',
      tier: 'lossless',
    })
    expect(
      deviceFormat({
        ...deviceSong(1, 'Music/FXM/a.oga'),
        mimeType: 'audio/ogg',
        volume: '1234-abcd',
      }),
    ).toMatchObject({ codec: 'vorbis' })
    expect(song('audio/ogg', 'Music/Other/a.oga')?.tier).not.toBe('lossless')
    expect(song('audio/ogg', 'Music/Other/a.oga')).toMatchObject({ codec: 'vorbis' })
  })

  it('goes by the extension when MediaStore gives a type FXM doesn’t know', () => {
    expect(song('audio/x-unknown', 'Music/a.flac')).toMatchObject({
      codec: 'flac',
      tier: 'lossless',
    })
    expect(song('application/octet-stream', 'Music/b.mka')).toMatchObject({ codec: 'opus' })
    expect(song('audio/x-unknown', 'Music/c.opus')).toMatchObject({
      codec: 'opus',
      container: 'ogg',
    })
    expect(song('audio/x-unknown', 'Music/d.xyz')).toBeUndefined()
    // Names of Object's own members are no format.
    expect(song('constructor', 'Music/e.constructor')).toBeUndefined()
    expect(song('toString', 'Music/f.toString')).toBeUndefined()
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
