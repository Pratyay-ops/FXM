import { type AudioCandidate, formatId } from '@fxm/core'
import { Player, type PlayerOptions } from '@fxm/player'
import { FakeEngine, FakeResolver, testStream, testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { getLibrary } from '../../db/repo'
import { testRepo } from '../../test/library-fixtures'
import { connectPlayRecorder, MIN_RECORDED_PLAY_MS, PLAY_OUTCOMES } from './play-recorder'

const T0 = Date.UTC(2026, 9, 26, 9)
const HOUR = 60 * 60 * 1000
const [a, b, c] = ['a', 'b', 'c'].map((name) => testTrack(name))
if (a === undefined || b === undefined || c === undefined) throw new Error('no tracks')

/** Lets the player's pending loads finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(options: Partial<PlayerOptions> = {}, connect = true) {
  let clock = T0
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({
    engine,
    resolver,
    stallTimeoutMs: 0,
    preload: false,
    maxRetries: 0,
    now: () => clock,
    ...options,
  })
  const plays: NewPlay[] = []
  const pageEvents = new EventTarget()
  const record = async (play: NewPlay) => {
    plays.push(play)
  }
  const start = () => connectPlayRecorder(player, { record, now: () => clock, pageEvents })
  const stop = connect ? start() : () => {}
  return {
    player,
    engine,
    resolver,
    plays,
    pageEvents,
    start,
    stop,
    now: () => clock,
    /** Plays on for `ms`: the clock and the position move together, a quarter second a step. */
    listen(ms: number) {
      for (let done = 0; done < ms; done += 250) {
        const step = Math.min(250, ms - done)
        clock += step
        engine.progress(engine.positionMs + step)
      }
    },
    /** Lets time pass without the position moving. */
    wait(ms: number) {
      clock += ms
    },
  }
}

describe('connectPlayRecorder', () => {
  it('records a track played to the end, with its stream, length and start', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a, b])
    listen(179_800)
    engine.end()
    await settle()
    expect(plays).toEqual([
      {
        track: a,
        playedAt: T0,
        playedMs: 179_800,
        durationMs: 180_000,
        completed: true,
        skipped: false,
        stream: {
          source: 'ytm',
          codec: 'opus',
          container: 'webm',
          bitrateKbps: 160,
          tier: 'high',
          media: 'audio',
        },
      },
    ])
  })

  it('records a skip, with the time played until then', async () => {
    const { player, plays, listen, now } = setup()
    await player.setQueue([a, b])
    listen(20_000)
    await player.next()
    expect(plays).toMatchObject([{ track: a, playedMs: 20_000, completed: false, skipped: true }])
    listen(5_000)
    await player.play(0)
    expect(plays[1]).toMatchObject({ track: b, playedAt: now() - 5_000, skipped: true })
  })

  it('counts listening only: no pauses, buffering, seeks ahead or a device asleep', async () => {
    const { player, engine, plays, listen, wait } = setup()
    await player.setQueue([a, b])
    listen(10_000)
    player.pause()
    wait(60_000)
    await player.play()
    listen(5_000)
    player.seek(100_000)
    listen(5_000)
    engine.emit('waiting', undefined)
    wait(10_000)
    listen(1_000)
    wait(3 * HOUR)
    listen(1_000)
    await player.next()
    expect(plays[0]?.playedMs).toBe(22_000)
  })

  it('ends a play when the track restarts, and starts another', async () => {
    const { player, plays, listen } = setup()
    await player.setQueue([a, b])
    listen(10_000)
    await player.previous()
    listen(5_000)
    await player.next()
    expect(plays).toMatchObject([
      { track: a, playedMs: 10_000, completed: false, skipped: false },
      { track: a, playedMs: 5_000, skipped: true },
    ])
  })

  it('records each time round a repeated track', async () => {
    const { player, engine, plays, listen } = setup()
    player.setRepeat('one')
    await player.setQueue([a, b])
    listen(180_000)
    engine.end()
    await settle()
    listen(30_000)
    await player.next()
    expect(plays).toMatchObject([
      { track: a, playedMs: 180_000, completed: true },
      { track: a, playedMs: 30_000, completed: false, skipped: true },
    ])
  })

  it('completes the last play when the queue ends', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a])
    listen(60_000)
    engine.end()
    await settle()
    expect(plays).toMatchObject([{ track: a, playedMs: 60_000, completed: true, skipped: false }])
    // Playing again after the end starts a new play.
    await player.play()
    listen(2_000)
    await player.setQueue([b])
    expect(plays[1]).toMatchObject({ track: a, playedMs: 2_000, completed: false })
  })

  it('records no verdict when the user goes back or starts something else', async () => {
    const { player, plays, listen } = setup()
    await player.setQueue([a, b], { startIndex: 1 })
    listen(2_000)
    await player.previous()
    listen(10_000)
    await player.setQueue([c])
    expect(plays).toMatchObject([
      { track: b, playedMs: 2_000, completed: false, skipped: false },
      { track: a, playedMs: 10_000, completed: false, skipped: false },
    ])
  })

  it('counts removing the playing item and jumping away as skips', async () => {
    const { player, plays, listen } = setup()
    await player.setQueue([a, b, c])
    listen(3_000)
    player.remove(0)
    await settle()
    listen(4_000)
    await player.play(1)
    expect(plays).toMatchObject([
      { track: a, playedMs: 3_000, skipped: true },
      { track: b, playedMs: 4_000, skipped: true },
    ])
  })

  it('records a failed track without a verdict', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a, b])
    listen(10_000)
    engine.fail('decode')
    await settle()
    expect(plays).toMatchObject([{ track: a, playedMs: 10_000, completed: false, skipped: false }])
    expect(player.getState().queue.index).toBe(1)
  })

  it('leaves out quick skips through the queue', async () => {
    const { player, plays, listen } = setup()
    await player.setQueue([a, b, c])
    listen(MIN_RECORDED_PLAY_MS - 250)
    await player.next()
    await player.next()
    expect(plays).toEqual([])
  })

  it('records where the queue started and the matched song that played', async () => {
    const { player, resolver, plays, listen } = setup()
    const spotify = testTrack('s', {
      id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
      source: 'spotify',
    })
    const matched: AudioCandidate = {
      source: 'ytm',
      ref: 'matched',
      kind: 'song',
      title: 's',
      artists: ['s artist'],
      confidence: 0.97,
      evidence: ['isrc'],
    }
    resolver.handler = (item) => ({ stream: testStream(item.track.title), candidate: matched })
    const album = formatId('spotify', 'album', 'record')
    await player.setQueue([spotify, a], { context: { type: 'album', id: album, title: 'Record' } })
    listen(30_000)
    await player.next()
    expect(plays[0]).toMatchObject({
      context: { type: 'album', id: album, title: 'Record' },
      stream: { source: 'ytm', audioId: 'ytm:track:matched', codec: 'opus' },
    })
  })

  it('records the length the engine reports', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a, b])
    engine.emit('durationchange', 200_000)
    listen(3_000)
    await player.next()
    expect(plays[0]?.durationMs).toBe(200_000)
  })

  it('saves the play in progress when the page goes away', async () => {
    const { player, plays, pageEvents, listen } = setup()
    await player.setQueue([a, b])
    listen(10_000)
    pageEvents.dispatchEvent(new Event('pagehide'))
    expect(plays).toMatchObject([{ track: a, playedMs: 10_000, completed: false, skipped: false }])
    // Back from the page cache, paused, the rest of the track is a play of its own.
    player.pause()
    await player.play()
    listen(5_000)
    await player.next()
    expect(plays[1]).toMatchObject({ track: a, playedMs: 5_000, skipped: true })
  })

  it('starts with what is playing when it connects, and stops when disconnected', async () => {
    const { player, plays, pageEvents, listen, start, now } = setup({}, false)
    await player.setQueue([a, b])
    listen(5_000)
    const stop = start()
    const connectedAt = now()
    listen(5_000)
    await player.next()
    expect(plays).toMatchObject([{ track: a, playedAt: connectedAt, playedMs: 5_000 }])
    listen(5_000)
    stop()
    await player.next()
    pageEvents.dispatchEvent(new Event('pagehide'))
    expect(plays).toHaveLength(1)
  })

  it('logs a play it could not save, and carries on', async () => {
    const { player, listen, now } = setup({}, false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(async () => {
      throw new Error('disk full')
    })
    connectPlayRecorder(player, { record: failing, now, pageEvents: null })
    await player.setQueue([a, b])
    listen(5_000)
    await player.next()
    await settle()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('The play could not be saved', expect.any(Error))
  })

  it('maps every cause of a track change to an outcome', () => {
    expect(PLAY_OUTCOMES).toEqual({
      ended: { completed: true, skipped: false },
      next: { completed: false, skipped: true },
      jump: { completed: false, skipped: true },
      removed: { completed: false, skipped: true },
      previous: { completed: false, skipped: false },
      queue: { completed: false, skipped: false },
      failed: { completed: false, skipped: false },
      restore: { completed: false, skipped: false },
    })
  })
})

describe('plays in the library', () => {
  it('reach the history and the listening affinity', async () => {
    const repo = testRepo({ now: () => T0 + HOUR })
    const { player, listen, now } = setup({}, false)
    connectPlayRecorder(player, { record: (play) => repo.recordPlay(play), now, pageEvents: null })
    await player.setQueue([a, b])
    listen(18_000)
    await player.next()
    await vi.waitFor(async () => expect(await repo.history()).toHaveLength(1))
    expect((await repo.history())[0]).toMatchObject({
      trackId: a.id,
      playedMs: 18_000,
      durationMs: 180_000,
      skipped: true,
    })
    const [affinity] = await repo.getAffinity('track', ['youtube:track:a'])
    expect(affinity?.entry).toMatchObject({ plays: 1 })
    expect(affinity?.entry.score).toBeCloseTo(0.1, 12)
    expect(affinity?.entry.skips).toBeCloseTo(0.9, 12)
  })

  it('go to the app’s library by default, loading it on the first play', async () => {
    const { player, listen, now } = setup({}, false)
    connectPlayRecorder(player, { now, pageEvents: null })
    await player.setQueue([a, b])
    listen(5_000)
    await player.next()
    await vi.waitFor(async () => expect(await getLibrary().history()).toHaveLength(1))
  })
})
