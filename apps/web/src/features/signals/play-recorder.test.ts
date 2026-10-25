import { type AudioCandidate, formatId } from '@fxm/core'
import { Player, type PlayerOptions } from '@fxm/player'
import { FakeEngine, FakeResolver, testStream, testTrack } from '@fxm/player/testing'
import { describe, expect, it, vi } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { getLibrary, resetLibrary } from '../../db/repo'
import { testRepo } from '../../test/library-fixtures'
import {
  ABANDONED_AFTER_MS,
  CHECKPOINT_INTERVAL_MS,
  connectPlayRecorder,
  MIN_RECORDED_PLAY_MS,
  PLAY_OUTCOMES,
  type PlayRecorderOptions,
  type PlayStorage,
  UNSAVED_PLAYS_PREFIX,
} from './play-recorder'

const T0 = Date.UTC(2026, 9, 26, 9)
const HOUR = 60 * 60 * 1000
const [a, b, c] = ['a', 'b', 'c'].map((name) => testTrack(name))
if (a === undefined || b === undefined || c === undefined) throw new Error('no tracks')

/** Lets the player's pending loads finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Web Storage in memory. */
class MemoryStorage implements PlayStorage {
  readonly items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
}

function setup(
  options: Partial<PlayerOptions> = {},
  connect = true,
  recorder: Partial<PlayRecorderOptions> = {},
) {
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
  const storage = new MemoryStorage()
  let hidden = false
  const record = async (play: NewPlay) => {
    plays.push(play)
  }
  const start = () =>
    connectPlayRecorder(player, {
      record,
      now: () => clock,
      pageEvents,
      storage,
      isHidden: () => hidden,
      pageId: 'this-page',
      ...recorder,
    })
  const stop = connect ? start() : () => {}
  return {
    player,
    engine,
    resolver,
    plays,
    pageEvents,
    storage,
    start,
    stop,
    now: () => clock,
    /** Hides the page, as when the user switches apps. */
    hide() {
      hidden = true
      pageEvents.dispatchEvent(new Event('visibilitychange'))
    },
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

  it('counts a track sought to its end as skipped, by the time heard', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a, b])
    listen(2_500)
    player.seek(179_000)
    listen(1_000)
    engine.end()
    await settle()
    expect(plays).toMatchObject([{ track: a, playedMs: 3_500, completed: false, skipped: true }])
  })

  it('records a stream that ended early without a verdict', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a, b])
    listen(30_000)
    engine.end()
    await settle()
    expect(plays).toMatchObject([{ track: a, playedMs: 30_000, completed: false, skipped: false }])
  })

  it('completes a track of unknown length that reaches its end', async () => {
    const { durationMs: _length, ...rest } = a as NonNullable<typeof a>
    const { player, engine, plays, listen } = setup()
    await player.setQueue([rest, b])
    listen(20_000)
    engine.end()
    await settle()
    expect(plays).toMatchObject([{ playedMs: 20_000, completed: true }])
    expect(plays[0]).not.toHaveProperty('durationMs')
  })

  it('completes the last play when the queue ends', async () => {
    const { player, engine, plays, listen } = setup()
    await player.setQueue([a])
    listen(90_000)
    engine.end()
    await settle()
    expect(plays).toMatchObject([{ track: a, playedMs: 90_000, completed: true, skipped: false }])
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
    connectPlayRecorder(player, { record: failing, now, pageEvents: null, storage: null })
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

describe('checkpoints', () => {
  const KEY = `${UNSAVED_PLAYS_PREFIX}this-page`

  /** The plays a page keeps unsaved in `storage`. */
  function unsaved(storage: MemoryStorage, key = KEY): NewPlay[] | undefined {
    const raw = storage.getItem(key)
    return raw === null ? undefined : (JSON.parse(raw) as { plays: NewPlay[] }).plays
  }

  it('keeps the play in progress every half minute of listening and when the page hides', async () => {
    const { player, storage, listen, hide } = setup()
    await player.setQueue([a, b])
    listen(CHECKPOINT_INTERVAL_MS - 1_000)
    expect(unsaved(storage)).toBeUndefined()
    listen(1_000)
    expect(unsaved(storage)).toMatchObject([
      { track: a, playedAt: T0, playedMs: 30_000, completed: false, skipped: false },
    ])
    listen(5_000)
    hide()
    expect(unsaved(storage)?.[0]?.playedMs).toBe(35_000)
  })

  it('keeps a finished play until it is saved', async () => {
    let save = () => {}
    const plays: NewPlay[] = []
    const record = (play: NewPlay) =>
      new Promise<void>((resolve) => {
        plays.push(play)
        save = resolve
      })
    const { player, storage, listen } = setup({}, true, { record })
    await player.setQueue([a, b])
    listen(10_000)
    await player.next()
    expect(unsaved(storage)).toMatchObject([{ track: a, playedMs: 10_000, skipped: true }])
    save()
    await settle()
    expect(unsaved(storage)).toBeUndefined()
    expect(plays).toHaveLength(1)
  })

  it('keeps nothing once disconnected, and nothing without storage', async () => {
    const { player, storage, listen, stop } = setup()
    await player.setQueue([a, b])
    listen(CHECKPOINT_INTERVAL_MS)
    stop()
    expect(storage.items.size).toBe(0)
    const none = setup({}, true, { storage: null })
    await none.player.setQueue([a, b])
    none.listen(CHECKPOINT_INTERVAL_MS)
    expect(none.storage.items.size).toBe(0)
  })

  it('records what a page that went away left unsaved, once', async () => {
    const { player, storage, plays, listen, start, now } = setup({}, false)
    const gone = `${UNSAVED_PLAYS_PREFIX}gone-page`
    const left: NewPlay = {
      track: c,
      playedAt: T0 - HOUR,
      playedMs: 42_000,
      durationMs: 180_000,
      completed: false,
      skipped: false,
      context: { type: 'album', id: 'ytm:album:x' },
      stream: { source: 'ytm', codec: 'opus' },
    }
    storage.setItem(gone, JSON.stringify({ savedAt: now() - ABANDONED_AFTER_MS, plays: [left] }))
    // A page that may still be open keeps its plays.
    const open = `${UNSAVED_PLAYS_PREFIX}open-page`
    storage.setItem(open, JSON.stringify({ savedAt: now() - 1000, plays: [left] }))
    storage.setItem(`${UNSAVED_PLAYS_PREFIX}broken`, '{not json')
    start()
    await vi.waitFor(() => expect(plays).toEqual([left]))
    expect(storage.getItem(gone)).toBeNull()
    expect(storage.getItem(`${UNSAVED_PLAYS_PREFIX}broken`)).toBeNull()
    expect(storage.getItem(open)).not.toBeNull()
    await player.setQueue([a])
    listen(2_000)
    await settle()
    expect(plays).toHaveLength(1)
  })

  it('drops unsaved plays that are not plays', async () => {
    const { storage, plays, start, now } = setup({}, false)
    const play = { track: c, playedAt: T0 - HOUR, playedMs: 5_000, completed: false, skipped: true }
    storage.setItem(
      `${UNSAVED_PLAYS_PREFIX}old`,
      JSON.stringify({
        savedAt: now() - 2 * ABANDONED_AFTER_MS,
        plays: [null, { ...play, track: { id: 'nope' } }, { ...play, playedAt: 'soon' }, play],
      }),
    )
    start()
    await vi.waitFor(() => expect(plays).toEqual([play]))
  })

  it('makes one play in the library of a checkpoint and the page’s own save', async () => {
    const repo = testRepo({ now: () => T0 + 2 * ABANDONED_AFTER_MS })
    const record = (play: NewPlay) => repo.recordPlay(play)
    const first = setup({}, true, { record })
    await first.player.setQueue([a, b])
    first.listen(CHECKPOINT_INTERVAL_MS)
    // Another page opens much later, while the first one is paused, and records its checkpoint.
    const second = setup({}, false, { record, pageId: 'second-page' })
    for (const [key, value] of first.storage.items) second.storage.setItem(key, value)
    second.listen(2 * ABANDONED_AFTER_MS)
    second.start()
    await vi.waitFor(async () => expect(await repo.history()).toHaveLength(1))
    // The first page carries on and saves the play: the library keeps its fuller record.
    first.listen(20_000)
    await first.player.next()
    await vi.waitFor(async () =>
      expect(await repo.history()).toEqual([
        expect.objectContaining({ playedMs: 50_000, skipped: true }),
      ]),
    )
  })
})

describe('plays in the library', () => {
  it('reach the history and the listening affinity', async () => {
    const repo = testRepo({ now: () => T0 + HOUR })
    const { player, listen, now } = setup({}, false)
    connectPlayRecorder(player, {
      record: (play) => repo.recordPlay(play),
      now,
      pageEvents: null,
      storage: null,
    })
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

  it('go to the app’s library by default, which starts loading at once', async () => {
    await resetLibrary({ now: () => T0 + HOUR })
    const { player, listen, now } = setup({}, false)
    connectPlayRecorder(player, { now, pageEvents: null, storage: null })
    await player.setQueue([a, b])
    listen(5_000)
    await player.next()
    await vi.waitFor(async () => expect(await getLibrary().history()).toHaveLength(1))
  })
})
