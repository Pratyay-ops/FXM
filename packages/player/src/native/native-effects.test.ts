import {
  type AudioEffectsSettings,
  DEFAULT_AUDIO_EFFECTS,
  equalizerPreset,
  type StreamLoudness,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createFakeFxmPlayer } from '../testing/fake-fxm-player'
import { testStream, testTrack, testTracks } from '../testing/fixtures'
import { nativeEntry, nativeSource, restoreStream } from './entries'
import { NativeEngine } from './native-engine'
import { nativeSetup, settle } from './test-harness'

const LOUD: StreamLoudness = { trackLufs: -10.11, source: 'youtube' }
const ROCK = equalizerPreset('rock').gainsDb

function effects(patch: Partial<AudioEffectsSettings> = {}): AudioEffectsSettings {
  return { ...DEFAULT_AUDIO_EFFECTS, ...patch }
}

describe('NativeEngine: audio effects', () => {
  it('sends the equalizer, loudness and speed to Media3', async () => {
    const { plugin, player } = nativeSetup()
    player.setAudioEffects(
      effects({ equalizer: { enabled: true, gainsDb: ROCK, preset: 'rock' }, playbackRate: 1.25 }),
    )
    await settle()
    expect(plugin.effects).toEqual({
      equalizer: { enabled: true, gainsDb: [...ROCK] },
      loudness: { enabled: true, targetLufs: -14, mode: 'track' },
      speed: 1.25,
    })
    expect(plugin.calls.filter((call) => call.startsWith('setEffects')).at(-1)).toBe(
      `setEffects:eq=${ROCK.join(',')} loudness=-14 speed=1.25`,
    )
    expect(player.getState().playbackRate).toBe(1.25)
    expect(player.effectsSupport()).toEqual({ effects: true, playbackRate: true, crossfade: false })
  })

  it('reports each loaded track’s loudness gain, turning down only', async () => {
    const { player, resolver } = nativeSetup()
    resolver.handler = (item) => ({
      stream: testStream(item.track.title, item.track.title === 'a' ? { loudness: LOUD } : {}),
    })
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(player.getState().effects).toEqual({
      equalizer: 'off',
      loudness: 'on',
      loudnessGainDb: -3.89,
    })
    await player.next()
    await settle()
    expect(player.getState().effects.loudness).toBe('no-data')
  })

  it('gives every entry its loudness, so Media3 levels the ones it moves on to itself', () => {
    const entry = nativeEntry(
      'e1',
      { uid: 1, track: testTrack('a') },
      testStream('a', { loudness: LOUD }),
    )
    expect(entry.source.loudness).toEqual({ trackLufs: -10.11 })
    const album = nativeSource(
      testStream('b', { loudness: { trackLufs: -9, albumLufs: -10, source: 'replaygain' } }),
    )
    expect(album.loudness).toEqual({ trackLufs: -9, albumLufs: -10 })
    expect(nativeSource(testStream('c')).loudness).toBeUndefined()
    // The stream read back from the entry keeps it.
    expect(restoreStream(entry)?.loudness).toEqual(LOUD)
  })

  it('says the effects are unavailable with a native side that has none', async () => {
    const plugin = createFakeFxmPlayer()
    Object.assign(plugin, { setEffects: undefined, setSleepTimer: undefined })
    const engine = new NativeEngine({ plugin })
    const statuses: string[] = []
    engine.on('effects', (status) => statuses.push(`${status.equalizer} ${status.loudness}`))
    engine.setEffects({
      equalizer: { enabled: true, gainsDb: ROCK, preset: 'rock' },
      loudness: DEFAULT_AUDIO_EFFECTS.loudness,
    })
    engine.setSleepTimer({ endOfTrack: true })
    await settle()
    expect(statuses).toEqual(['unavailable unavailable'])
    expect(plugin.calls.some((call) => call.startsWith('setSleepTimer'))).toBe(false)
    engine.destroy()
  })
})

describe('NativeEngine: sleep timer', () => {
  it('runs the timer natively and follows its pause', async () => {
    const { plugin, player } = nativeSetup({ player: { now: () => 1_000_000 } })
    const sleeps: string[] = []
    player.on('sleep', ({ reason }) => sleeps.push(reason))
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    plugin.ready()
    player.setSleepTimer({ afterMs: 60_000 })
    await settle()
    expect(plugin.sleepTimer).toEqual({ endsAt: 1_060_000, fadeMs: 12_000, endOfTrack: false })
    plugin.sleep('timer')
    await settle()
    expect(player.getState()).toMatchObject({ status: 'paused', sleepTimer: undefined })
    expect(sleeps).toEqual(['timer'])
  })

  it('pauses natively at the end of the track, and cancels', async () => {
    const { plugin, player } = nativeSetup()
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    player.setSleepTimer({ endOfTrack: true })
    await settle()
    expect(plugin.sleepTimer).toEqual({ endsAt: null, fadeMs: 0, endOfTrack: true })
    player.setSleepTimer(null)
    await settle()
    expect(plugin.sleepTimer).toEqual({ endsAt: null, fadeMs: 0, endOfTrack: false })
    expect(plugin.calls.filter((call) => call.startsWith('setSleepTimer'))).toEqual([
      'setSleepTimer:end',
      'setSleepTimer:off',
    ])
  })
})
