import { formatId } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary, type NewPlay } from '../../db/repo'
import { setupTestPlayback } from '../now-playing/testing'
import { announcePlayEnded, announcePlayStarted, onPlays, type PlayStarted } from './play-events'
import { connectPlayRecorder } from './play-recorder'

const T0 = Date.UTC(2026, 9, 26, 9)
const a = testTrack('a')
const b = testTrack('b')

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function listen() {
  const started: PlayStarted[] = []
  const ended: NewPlay[] = []
  stops.push(onPlays({ started: (play) => started.push(play), ended: (play) => ended.push(play) }))
  return { started, ended }
}

describe('play events', () => {
  it('reach every listener until it stops listening', () => {
    const first = listen()
    const second = listen()
    announcePlayStarted({ track: a, startedAt: T0 })
    stops.shift()?.()
    announcePlayStarted({ track: b, startedAt: T0 + 1 })
    expect(first.started.map((play) => play.track.title)).toEqual(['a'])
    expect(second.started.map((play) => play.track.title)).toEqual(['a', 'b'])
  })

  it('keep going when a listener fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    stops.push(
      onPlays({
        ended: () => {
          throw new Error('broken listener')
        },
      }),
    )
    const after = listen()
    const play: NewPlay = { track: a, playedMs: 1000, completed: false, skipped: true }
    announcePlayEnded(play)
    expect(after.ended).toEqual([play])
    expect(error).toHaveBeenCalledWith('A play listener failed', expect.any(Error))
  })
})

describe('the play recorder', () => {
  it('announces each play as it starts and as it is recorded', async () => {
    let clock = T0
    const engine = new FakeEngine()
    const player = new Player({
      engine,
      resolver: new FakeResolver(),
      stallTimeoutMs: 0,
      preload: false,
      maxRetries: 0,
      now: () => clock,
    })
    const recorded: NewPlay[] = []
    stops.push(
      connectPlayRecorder(player, {
        record: async (play) => {
          recorded.push(play)
        },
        now: () => clock,
        pageEvents: null,
      }),
    )
    const heard = listen()
    const album = formatId('ytm', 'album', 'x')
    await player.setQueue([a, b], { context: { type: 'album', id: album, title: 'X' } })
    expect(heard.started).toEqual([
      { track: a, startedAt: T0, context: { type: 'album', id: album, title: 'X' } },
    ])
    for (let ms = 0; ms < 120_000; ms += 250) {
      clock += 250
      engine.progress(engine.positionMs + 250)
    }
    await player.next()
    expect(heard.ended).toEqual(recorded)
    expect(heard.ended[0]).toMatchObject({
      track: a,
      playedAt: T0,
      playedMs: 120_000,
      skipped: true,
    })
    expect(heard.started.map((play) => play.track.title)).toEqual(['a', 'b'])
  })
})

describe('the app’s player', () => {
  it('announces its plays, as it records them, for scrobbling to follow', async () => {
    let clock = T0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const { player, engine } = setupTestPlayback({ recordPlays: true })
    const heard = listen()
    await player.setQueue([a, b])
    expect(heard.started).toEqual([{ track: a, startedAt: T0 }])
    for (let ms = 0; ms < 179_750; ms += 250) {
      clock += 250
      engine.progress(engine.positionMs + 250)
    }
    engine.end()

    await vi.waitFor(async () => expect(await getLibrary().history()).toHaveLength(1))
    expect(heard.ended).toHaveLength(1)
    expect(heard.ended[0]).toMatchObject({
      track: a,
      playedAt: T0,
      playedMs: 179_750,
      completed: true,
      skipped: false,
    })
    expect(heard.started.map((play) => play.track.title)).toEqual(['a', 'b'])
  })
})
