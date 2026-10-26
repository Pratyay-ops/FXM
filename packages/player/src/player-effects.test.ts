import {
  type AudioEffectsSettings,
  createSeededRandom,
  currentQueueItem,
  DEFAULT_AUDIO_EFFECTS,
  equalizerPreset,
  formatId,
  type StreamLoudness,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineSleepTimer } from './engine'
import { Player, type PlayerOptions } from './player'
import { FakeEngine, FakeResolver, testStream, testTrack, testTracks } from './testing'

function setup(options: Partial<PlayerOptions> = {}, engine = new FakeEngine()) {
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver, random: createSeededRandom(1), ...options })
  return { engine, resolver, player }
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function effects(patch: Partial<AudioEffectsSettings> = {}): AudioEffectsSettings {
  return { ...DEFAULT_AUDIO_EFFECTS, ...patch }
}

const withCrossfade = (durationMs: number, sameAlbum = false) =>
  effects({ crossfade: { durationMs, sameAlbum } })

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const abc = testTracks('a', 'b', 'c')

function trackChanges(player: Player): string[] {
  const changes: string[] = []
  player.on('trackchange', ({ item, previous, cause }) => {
    changes.push(`${previous?.track.title} -> ${item?.track.title} (${cause})`)
  })
  return changes
}

function sleeps(player: Player): string[] {
  const seen: string[] = []
  player.on('sleep', ({ reason }) => seen.push(reason))
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Player: audio effects', () => {
  it('hands the equalizer and loudness to the engine, and shows what they do', async () => {
    const { player, engine, resolver } = setup()
    expect(engine.effects).toEqual({
      equalizer: DEFAULT_AUDIO_EFFECTS.equalizer,
      loudness: DEFAULT_AUDIO_EFFECTS.loudness,
    })
    // YouTube's loudnessDb 3.89: 3.89 dB above its -14 LUFS reference.
    const loudness: StreamLoudness = { trackLufs: -10.11, source: 'youtube' }
    resolver.handler = (item) => ({ stream: testStream(item.track.title, { loudness }) })
    await player.setQueue(abc)
    expect(player.getState().effects).toEqual({
      equalizer: 'off',
      loudness: 'on',
      loudnessGainDb: -3.89,
    })
    const rock = {
      enabled: true,
      gainsDb: equalizerPreset('rock').gainsDb,
      preset: 'rock' as const,
    }
    player.setAudioEffects(effects({ equalizer: rock }))
    expect(engine.effects?.equalizer).toEqual(rock)
    expect(player.getState().effects.equalizer).toBe('on')
    expect(player.getAudioEffects().equalizer).toEqual(rock)
  })

  it('validates the settings it is given', () => {
    const { player, engine } = setup({
      effects: {
        playbackRate: 7,
        crossfade: { durationMs: 99_000 },
      } as unknown as AudioEffectsSettings,
    })
    expect(player.getAudioEffects().playbackRate).toBe(2)
    expect(player.getAudioEffects().crossfade.durationMs).toBe(12_000)
    expect(engine.playbackRate).toBe(2)
  })

  it('says the effects are unavailable with an engine that has none', () => {
    const engine = new FakeEngine()
    Object.assign(engine, {
      setEffects: undefined,
      setPlaybackRate: undefined,
      crossfade: undefined,
    })
    const { player } = setup({}, engine)
    expect(player.getState().effects).toEqual({
      equalizer: 'off',
      loudness: 'unavailable',
      loudnessGainDb: 0,
    })
    player.setAudioEffects(effects({ playbackRate: 1.5 }))
    expect(player.getState().playbackRate).toBe(1)
    expect(player.effectsSupport()).toEqual({
      effects: false,
      playbackRate: false,
      crossfade: false,
    })
  })

  it('sets the playback speed', () => {
    const { player, engine } = setup()
    expect(player.getState().playbackRate).toBe(1)
    player.setPlaybackRate(1.25)
    expect(engine.playbackRate).toBe(1.25)
    expect(player.getState().playbackRate).toBe(1.25)
    expect(player.getAudioEffects().playbackRate).toBe(1.25)
    expect(player.effectsSupport()).toEqual({ effects: true, playbackRate: true, crossfade: true })
  })
})

describe('Player: crossfade', () => {
  /** Plays a, b, c with crossfade, with b prepared once a is 30 s from its end. */
  async function playing(crossfadeMs = 6000, options: Partial<PlayerOptions> = {}) {
    const context = setup({ effects: withCrossfade(crossfadeMs), ...options })
    await context.player.setQueue(abc)
    context.engine.progress(150_000)
    await settle()
    return context
  }

  it('starts the next track that long before the end, without a load or a pause', async () => {
    const { player, engine } = await playing(6000)
    const changes = trackChanges(player)
    const pauses = engine.count('pause')
    engine.progress(173_000)
    expect(engine.crossfades).toEqual([])
    engine.progress(174_500)
    expect(engine.crossfades).toEqual([
      { source: expect.objectContaining({ stream: testStream('b') }), durationMs: 5500 },
    ])
    expect(engine.crossfades[0]?.source.item?.track.title).toBe('b')
    expect(changes).toEqual(['a -> b (ended)'])
    expect(current(player)).toBe('b')
    expect(engine.count('load')).toBe(1)
    expect(engine.count('pause')).toBe(pauses)
    expect(player.getState()).toMatchObject({
      status: 'playing',
      positionMs: 0,
      stream: testStream('b'),
    })
    // The new track plays on as any other: positions, then its own preparation and fade.
    await settle()
    engine.progress(10_000)
    expect(player.getState().positionMs).toBe(10_000)
    engine.progress(150_000)
    await settle()
    engine.progress(175_000)
    expect(current(player)).toBe('c')
    expect(engine.count('load')).toBe(1)
  })

  it('counts the time left at the playback speed', async () => {
    const { player, engine } = await playing(6000, {
      effects: effects({ playbackRate: 2, crossfade: { durationMs: 6000, sameAlbum: false } }),
    })
    engine.progress(167_000)
    expect(engine.crossfades).toEqual([])
    engine.progress(168_000)
    // 12 s of the track at twice the speed: 6 s.
    expect(engine.crossfades[0]?.durationMs).toBe(6000)
    expect(current(player)).toBe('b')
  })

  it('tries again on the next report when the engine is not ready', async () => {
    const { player, engine } = await playing(6000)
    engine.crossfadeResult = false
    engine.progress(175_000)
    expect(current(player)).toBe('a')
    engine.crossfadeResult = true
    engine.progress(175_250)
    expect(current(player)).toBe('b')
    expect(engine.crossfades[0]?.durationMs).toBe(4750)
  })

  it('lets the track end as usual too close to the end', async () => {
    const { player, engine } = await playing(6000)
    engine.crossfadeResult = false
    engine.progress(174_000)
    engine.crossfadeResult = true
    engine.progress(179_500)
    expect(engine.crossfades).toEqual([])
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(engine.count('load')).toBe(2)
  })

  it('does not fade without a prepared next track, or with crossfade off', async () => {
    const off = await playing(0)
    off.engine.progress(176_000)
    expect(off.engine.count('crossfade')).toBe(0)
    const { player, engine } = setup({ effects: withCrossfade(6000), preload: false })
    await player.setQueue(abc)
    engine.progress(176_000)
    await settle()
    expect(engine.count('crossfade')).toBe(0)
    expect(current(player)).toBe('a')
  })

  it('does not fade on repeat one, at the end of the queue or while paused', async () => {
    const repeat = await playing(6000)
    repeat.player.setRepeat('one')
    repeat.engine.progress(176_000)
    expect(repeat.engine.count('crossfade')).toBe(0)

    const last = setup({ effects: withCrossfade(6000) })
    await last.player.setQueue(testTracks('only'))
    last.engine.progress(176_000)
    await settle()
    expect(last.engine.count('crossfade')).toBe(0)

    const paused = await playing(6000)
    paused.player.pause()
    paused.engine.progress(176_000)
    expect(paused.engine.count('crossfade')).toBe(0)
  })

  it('keeps albums gapless unless the setting says otherwise', async () => {
    const album = { id: formatId('ytm', 'album', 'MPREb_x'), name: 'Album' }
    const tracks = ['a', 'b'].map((name) => testTrack(name, { album }))
    const gapless = setup({ effects: withCrossfade(6000) })
    await gapless.player.setQueue(tracks)
    gapless.engine.progress(150_000)
    await settle()
    gapless.engine.progress(176_000)
    expect(gapless.engine.count('crossfade')).toBe(0)

    const across = setup({ effects: withCrossfade(6000, true) })
    await across.player.setQueue(tracks)
    across.engine.progress(150_000)
    await settle()
    across.engine.progress(176_000)
    expect(across.engine.count('crossfade')).toBe(1)
  })

  it('does not fade into a track a sleep timer waits for the end of', async () => {
    const { player, engine } = await playing(6000)
    player.setSleepTimer({ endOfTrack: true })
    engine.progress(176_000)
    expect(engine.count('crossfade')).toBe(0)
  })

  it('pauses the engine when a listener pauses during the hand-over', async () => {
    const { player, engine } = await playing(6000)
    player.on('trackchange', () => player.pause())
    engine.progress(176_000)
    expect(current(player)).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(engine.paused).toBe(true)
  })

  it('uses the resolved candidate of the faded-in track', async () => {
    const { player, engine, resolver } = setup({ effects: withCrossfade(6000) })
    const candidate = {
      source: 'ytm' as const,
      ref: 'song-b',
      kind: 'song' as const,
      title: 'b',
      artists: ['b artist'],
      confidence: 0.95,
      evidence: ['isrc'],
    }
    resolver.handler = (item) =>
      item.track.title === 'b'
        ? { stream: testStream('b'), candidate }
        : { stream: testStream(item.track.title) }
    await player.setQueue(abc)
    engine.progress(150_000)
    await settle()
    engine.progress(176_000)
    expect(currentQueueItem(player.getState().queue)?.candidate).toEqual(candidate)
  })
})

describe('Player: sleep timer', () => {
  it('fades out and pauses after the time, then puts the output back', async () => {
    const { player, engine } = setup({ now: () => Date.now() })
    const seen = sleeps(player)
    await player.setQueue(abc)
    const start = Date.now()
    player.setSleepTimer({ afterMs: 60_000 })
    expect(player.getState().sleepTimer).toEqual({ endsAt: start + 60_000, fadeMs: 12_000 })
    await settle(47_999)
    expect(engine.count('fadeOutput')).toBe(0)
    await settle(1)
    expect(engine.calls.at(-1)).toEqual({ method: 'fadeOutput', args: [0, 12_000] })
    expect(player.getState().status).toBe('playing')
    await settle(12_000)
    expect(player.getState().status).toBe('paused')
    expect(engine.outputGain).toBe(1)
    expect(player.getState().sleepTimer).toBeUndefined()
    expect(seen).toEqual(['timer'])
  })

  it('fades over the whole time when it is shorter than the fade', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 5000 })
    await settle()
    expect(engine.calls.at(-1)).toEqual({ method: 'fadeOutput', args: [0, 5000] })
  })

  it('brings the output back when cancelled while fading', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 20_000 })
    await settle(15_000)
    expect(engine.outputGain).toBe(0)
    player.setSleepTimer(null)
    expect(engine.calls.at(-1)).toEqual({ method: 'fadeOutput', args: [1, 400] })
    expect(player.getState().sleepTimer).toBeUndefined()
    await settle(60_000)
    expect(player.getState().status).toBe('playing')
  })

  it('replaces a running timer', async () => {
    const { player } = setup()
    const seen = sleeps(player)
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 10_000 })
    player.setSleepTimer({ afterMs: 30_000 })
    await settle(20_000)
    expect(player.getState().status).toBe('playing')
    await settle(10_000)
    expect(player.getState().status).toBe('paused')
    expect(seen).toEqual(['timer'])
  })

  it('ends quietly when nothing plays at its time', async () => {
    const { player } = setup()
    const seen = sleeps(player)
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 10_000 })
    player.pause()
    await settle(10_000)
    expect(player.getState().sleepTimer).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('pauses at the end of the track, on the next one, without loading it', async () => {
    const { player, engine } = setup()
    const seen = sleeps(player)
    await player.setQueue(abc)
    const changes = trackChanges(player)
    player.setSleepTimer({ endOfTrack: true })
    expect(player.getState().sleepTimer).toEqual({ endOfTrack: true })
    engine.end()
    await settle()
    expect(changes).toEqual(['a -> b (ended)'])
    expect(player.getState()).toMatchObject({ status: 'paused', sleepTimer: undefined })
    expect(engine.count('load')).toBe(1)
    expect(seen).toEqual(['end-of-track'])
    await player.play()
    expect(engine.loadedUrls.at(-1)).toBe(testStream('b').url)
    expect(player.getState().status).toBe('playing')
  })

  it('stops a repeating track at its start, and the last track as the queue ends', async () => {
    const repeat = setup()
    await repeat.player.setQueue(abc)
    repeat.player.setRepeat('one')
    repeat.player.setSleepTimer({ endOfTrack: true })
    repeat.engine.progress(100_000)
    repeat.engine.end()
    await settle()
    expect(repeat.player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
    expect(current(repeat.player)).toBe('a')

    const last = setup()
    const ended: string[] = []
    last.player.on('queueend', () => ended.push('end'))
    await last.player.setQueue(testTracks('only'))
    last.player.setSleepTimer({ endOfTrack: true })
    last.engine.end()
    await settle()
    expect(last.player.getState().status).toBe('ended')
    expect(ended).toEqual(['end'])
  })

  it('hands the timer to an engine that runs its own, and follows it', async () => {
    const engine = new FakeEngine()
    const given: (EngineSleepTimer | null)[] = []
    Object.assign(engine, { setSleepTimer: (timer: EngineSleepTimer | null) => given.push(timer) })
    const { player } = setup({ now: () => Date.now() }, engine)
    const seen = sleeps(player)
    await player.setQueue(abc)
    const start = Date.now()
    player.setSleepTimer({ afterMs: 60_000 })
    expect(given).toEqual([{ endsAt: start + 60_000, fadeMs: 12_000 }])
    await settle(59_000)
    // The engine fades itself; the player doesn't.
    expect(engine.count('fadeOutput')).toBe(0)
    engine.emit('sleep', { reason: 'timer' })
    expect(player.getState()).toMatchObject({ status: 'paused', sleepTimer: undefined })
    expect(seen).toEqual(['timer'])
    player.setSleepTimer({ endOfTrack: true })
    expect(given.at(-1)).toEqual({ endOfTrack: true })
    player.setSleepTimer(null)
    expect(given.at(-1)).toBeNull()
  })

  it('pauses itself when an engine with its own timer did not', async () => {
    const engine = new FakeEngine()
    Object.assign(engine, { setSleepTimer: () => {} })
    const { player } = setup({}, engine)
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 10_000 })
    await settle(11_999)
    expect(player.getState().status).toBe('playing')
    await settle(1)
    expect(player.getState().status).toBe('paused')
  })

  it('stops with the player', async () => {
    const { player, engine } = setup()
    await player.setQueue(abc)
    player.setSleepTimer({ afterMs: 10_000 })
    player.destroy()
    await settle(20_000)
    expect(engine.count('fadeOutput')).toBe(0)
  })
})
