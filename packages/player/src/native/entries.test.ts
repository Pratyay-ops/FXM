import { describe, expect, it } from 'vitest'
import * as player from '../index'
import { createFakeFxmPlayer } from '../testing/fake-fxm-player'
import { testStream, testTrack } from '../testing/fixtures'
import * as testing from '../testing/index'
import { lockScreenArtwork, nativeEntry, nativeMetadata, nativeSource } from './entries'
import { findFxmPlayerPlugin } from './plugin'

describe('native entries', () => {
  it('carry what the notification and the lock screen show', () => {
    const track = testTrack('Creep', {
      artists: [{ name: 'Radiohead' }, { name: '' }],
      album: { name: 'Pablo Honey' },
      durationMs: 238_640,
      artwork: [
        { url: 'https://i.ytimg.com/a/60.jpg', width: 60, height: 60 },
        { url: 'https://i.ytimg.com/a/544.jpg', width: 544, height: 544 },
        { url: 'https://i.ytimg.com/a/1200.jpg', width: 1200, height: 1200 },
      ],
    })
    expect(nativeMetadata(track)).toEqual({
      title: 'Creep',
      artists: ['Radiohead'],
      album: 'Pablo Honey',
      artworkUrl: 'https://i.ytimg.com/a/544.jpg',
      durationMs: 238_640,
    })
    expect(nativeMetadata(testTrack(' ', { durationMs: 0 }))).toEqual({
      title: 'Untitled',
      artists: ['  artist'],
    })
  })

  it('pick HTTPS artwork, the last one when no size is given', () => {
    expect(lockScreenArtwork([])).toBeUndefined()
    expect(lockScreenArtwork([{ url: 'http://x.test/a.jpg', width: 100 }])).toBeUndefined()
    expect(
      lockScreenArtwork([{ url: 'https://x.test/small.jpg' }, { url: 'https://x.test/large.jpg' }]),
    ).toBe('https://x.test/large.jpg')
    expect(lockScreenArtwork([{ url: 'https://x.test/huge.jpg', width: 4000, height: 4000 }])).toBe(
      'https://x.test/huge.jpg',
    )
  })

  it('carry the stream’s URL, headers, expiry, IP binding and network', () => {
    const stream = testStream('a', {
      ipBound: true,
      expiresAt: 1_792_979_495_000.7,
      requestHeaders: { Referer: 'https://www.youtube.com/' },
    })
    expect(nativeSource(stream, 3)).toEqual({
      url: stream.url,
      ipBound: true,
      headers: { Referer: 'https://www.youtube.com/' },
      expiresAt: 1_792_979_495_000,
      network: 3,
    })
    expect(nativeSource(testStream('b', { requestHeaders: {} }))).toEqual({
      url: testStream('b').url,
      ipBound: false,
    })
    const entry = nativeEntry('n1-1', { uid: 4, track: testTrack('a') }, stream)
    expect(entry).toMatchObject({ id: 'n1-1', uid: 4, metadata: { title: 'a' } })
  })
})

describe('the FxmPlayer plugin', () => {
  it('is found only in the Android app, with all its methods', () => {
    const plugin = createFakeFxmPlayer()
    const android = { Capacitor: { isNativePlatform: () => true, Plugins: { FxmPlayer: plugin } } }
    expect(findFxmPlayerPlugin(android)).toBe(plugin)
    expect(findFxmPlayerPlugin({})).toBeUndefined()
    expect(
      findFxmPlayerPlugin({
        Capacitor: { isNativePlatform: () => false, Plugins: { FxmPlayer: plugin } },
      }),
    ).toBeUndefined()
    const { release: _release, ...partial } = plugin
    expect(
      findFxmPlayerPlugin({
        Capacitor: { isNativePlatform: () => true, Plugins: { FxmPlayer: partial } },
      }),
    ).toBeUndefined()
    expect(player.NativeEngine.ifAvailable(android)).toBeInstanceOf(player.NativeEngine)
  })

  it('and its engine are exported, with the fake under @fxm/player/testing', () => {
    for (const name of [
      'NativeEngine',
      'findFxmPlayerPlugin',
      'nativeSupport',
      'FXM_PLAYER_PLUGIN',
    ]) {
      expect(player).toHaveProperty(name)
    }
    expect(testing).toHaveProperty('createFakeFxmPlayer')
  })
})
