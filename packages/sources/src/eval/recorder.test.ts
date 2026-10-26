import {
  FxmError,
  formatId,
  type MatchSource,
  matchingEval,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { PageProviders } from './pages'
import { type RecorderBudget, recordGroups, recordingFingerprint } from './recorder'
import { checkpointStorage, type EvalCheckpoint, memoryStore } from './store'

type EvalGroup = matchingEval.EvalGroup

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('no network in tests')),
  platform: 'desktop',
  capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

function song(id: string, title: string, artist: string, seconds: number, album = title): Track {
  return {
    id: formatId('ytm', 'track', id),
    source: 'ytm',
    title,
    artists: [{ name: artist }],
    album: { name: album, id: formatId('ytm', 'album', `MPREb_${id}`) },
    durationMs: seconds * 1000,
    artwork: [],
    kind: 'song',
  }
}

const CREEP: MatchSource = {
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  album: { name: 'Pablo Honey' },
  durationMs: 238_000,
  isrc: 'GBAYE9200070',
  isrcOrigin: 'catalog',
  label: 'XL Recordings',
  releaseDate: '1993-02-22',
}

/** The data-export row of {@link CREEP}: names only. */
const CREEP_ROW: MatchSource = {
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  album: { name: 'Pablo Honey' },
}

function group(id: string, source: MatchSource, withRow = true): EvalGroup {
  return {
    id,
    split: matchingEval.splitOf(id),
    categories: ['mainstream'],
    provenance: ['test'],
    variants: [
      { slice: 'spotify', source },
      ...(withRow ? [{ slice: 'data-export' as const, source: CREEP_ROW }] : []),
    ],
  }
}

/** A fake YouTube Music: an ISRC hit for Creep, filler for anything else. */
function fakeYouTube(script: { failures?: Error[] } = {}) {
  const calls: string[] = []
  const failures = [...(script.failures ?? [])]
  const take = () => {
    const failure = failures.shift()
    if (failure !== undefined) throw failure
  }
  const providers: PageProviders = {
    music: {
      async search(query) {
        calls.push(`search:${query}`)
        take()
        const tracks =
          query === 'GBAYE9200070' || query.includes('Creep')
            ? [song('XFkzRNyygfk', 'Creep', 'Radiohead', 239, 'Pablo Honey')]
            : [song('filler00001', 'Something Else', 'Somebody', 200)]
        return { tracks: { items: tracks } }
      },
      async topResult(query) {
        calls.push(`top:${query}`)
        take()
        return undefined
      },
      async getDescription(id) {
        calls.push(`description:${id}`)
        take()
        return 'Provided to YouTube by XL\n\nCreep · Radiohead\n\nPablo Honey\n\n℗ 1993 XL Recordings\n\nReleased on: 1993-02-22\n\nMore text https://example.com'
      },
    },
  }
  return { providers, calls }
}

/**
 * A fake budget. With a checkpoint it keeps its pause there as the platform's budget does
 * (through `checkpointStorage`), and `whenAvailable` notes what the stored checkpoint held then.
 */
function fakeBudget(
  script: { refusals?: number; checkpoint?: EvalCheckpoint; stored?: () => EvalCheckpoint } = {},
) {
  let refusals = script.refusals ?? 0
  const events: string[] = []
  const storage = script.checkpoint === undefined ? undefined : checkpointStorage(script.checkpoint)
  let pausedUntil: number | undefined
  const budget: RecorderBudget = {
    async whenAvailable() {
      const stored = script.stored?.().budget['fxm.requestBudget']
      events.push(stored === undefined ? 'wait' : `wait (stored ${stored})`)
      pausedUntil = undefined
    },
    reportBotCheck(cause) {
      events.push(`bot-check:${cause}`)
      pausedUntil = 1_800_000
      storage?.setItem('fxm.requestBudget', JSON.stringify({ pausedUntil, pauseLevel: 1 }))
    },
    snapshot() {
      return pausedUntil === undefined ? {} : { bulkPausedUntil: pausedUntil }
    },
  }
  const refuse = () => {
    if (refusals <= 0) return
    refusals -= 1
    const error = new FxmError('RateLimited', 'spacing', { retryAfterMs: 5000 })
    throw Object.assign(error, { reason: 'spacing' })
  }
  return { budget, events, refuse }
}

const noSleep = async () => {}

describe('recordGroups', () => {
  it('records every page the planner asks for, once, and marks the group done', async () => {
    const store = memoryStore([group('sp:creep', CREEP)])
    const { providers, calls } = fakeYouTube()
    const { budget, events } = fakeBudget()
    const summary = await recordGroups({ providers, ctx, budget, store, sleep: noSleep })
    expect(summary.recorded).toEqual(['sp:creep'])
    expect(summary.remaining).toBe(0)
    expect(new Set(calls).size).toBe(calls.length)
    expect(calls[0]).toBe('search:GBAYE9200070')
    expect(events.filter((event) => event === 'wait')).toHaveLength(calls.length)
    const saved = await store.readGroup('sp:creep')
    expect(saved?.recording?.pages['isrc-songs/1/GBAYE9200070']).toEqual({ items: ['XFkzRNyygfk'] })
    expect(saved?.recording?.items.XFkzRNyygfk).toMatchObject({
      title: 'Creep',
      durationMs: 239000,
    })
    if (saved === undefined) throw new Error('no group')
    expect(store.checkpoint.record.done).toEqual({ 'sp:creep': recordingFingerprint(saved) })
    expect(store.checkpoint.requests.youtube).toBe(calls.length)
  })

  it('resumes: done groups and recorded pages are never fetched again', async () => {
    const store = memoryStore([
      group('sp:creep', CREEP),
      group('sp:other', { ...CREEP, title: 'Other', isrc: 'USAAA0000001' }),
    ])
    const first = fakeYouTube()
    const once = await recordGroups({
      providers: first.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      limit: 1,
      sleep: noSleep,
    })
    expect(once.recorded).toEqual(['sp:creep'])
    expect(once.remaining).toBe(1)
    const second = fakeYouTube()
    const again = await recordGroups({
      providers: second.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(again.recorded).toEqual(['sp:other'])
    expect(second.calls.some((call) => call.includes('GBAYE9200070'))).toBe(false)
    const third = fakeYouTube()
    const nothing = await recordGroups({
      providers: third.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(nothing.recorded).toEqual([])
    expect(third.calls).toEqual([])
  })

  it('records the pages of inputs a done group got later, and only those', async () => {
    // The inputs phase wrote the group with its Spotify input only (MusicBrainz had not
    // answered), and the recorder recorded it.
    const store = memoryStore([group('sp:creep', { ...CREEP, isrc: 'USZZZ9999999' }, false)])
    const first = fakeYouTube()
    await recordGroups({
      providers: first.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(first.calls).not.toContain('search:Radiohead Creep Pablo Honey')
    // A later inputs run adds the data-export row; the recorder fetches what it needs.
    const later = await store.readGroup('sp:creep')
    if (later === undefined) throw new Error('no group')
    later.variants.push({ slice: 'data-export', source: { ...CREEP_ROW, album: { name: 'Best' } } })
    await store.writeGroup(later)
    const second = fakeYouTube()
    const resumed = await recordGroups({
      providers: second.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(resumed.recorded).toEqual(['sp:creep'])
    expect(second.calls.length).toBeGreaterThan(0)
    expect(second.calls.some((call) => first.calls.includes(call))).toBe(false)
    const saved = await store.readGroup('sp:creep')
    const recording = saved?.recording
    if (saved === undefined || recording === undefined) throw new Error('no recording')
    for (const variant of saved.variants) {
      for (const options of matchingEval.RECORDING_OPTIONS) {
        expect(matchingEval.replayMatch(variant.source, recording, options).unrecorded).toEqual([])
      }
    }
    const third = fakeYouTube()
    await recordGroups({
      providers: third.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(third.calls).toEqual([])
  })

  it('checks the groups of an older checkpoint offline, without fetching a page twice', async () => {
    const store = memoryStore([group('sp:creep', CREEP)])
    await recordGroups({
      providers: fakeYouTube().providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    store.checkpoint.record.done = { 'sp:creep': '' }
    const again = fakeYouTube()
    const summary = await recordGroups({
      providers: again.providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(summary.recorded).toEqual(['sp:creep'])
    expect(again.calls).toEqual([])
    expect(store.checkpoint.record.done['sp:creep']).not.toBe('')
  })

  it('waits again when the budget turns a call away, without using a try', async () => {
    const store = memoryStore([group('sp:creep', CREEP)])
    const { budget, events, refuse } = fakeBudget({ refusals: 2 })
    const { providers } = fakeYouTube()
    const search = providers.music.search
    const wrapped: PageProviders = {
      music: {
        ...providers.music,
        search: async (...args) => {
          refuse()
          return search(...args)
        },
      },
    }
    const summary = await recordGroups({
      providers: wrapped,
      ctx,
      budget,
      store,
      maxAttempts: 1,
      sleep: noSleep,
    })
    expect(summary.recorded).toEqual(['sp:creep'])
    expect(events.slice(0, 3)).toEqual(['wait', 'wait', 'wait'])
  })

  it('stops the run after two bot checks, keeping what it recorded', async () => {
    const store = memoryStore([group('sp:creep', CREEP)])
    const botCheck = new FxmError('BotCheck', 'Sign in to confirm you are not a bot')
    const { providers } = fakeYouTube({ failures: [botCheck, botCheck] })
    const { budget, events } = fakeBudget()
    const summary = await recordGroups({ providers, ctx, budget, store, sleep: noSleep })
    expect(summary.stopped).toMatch(/2 bot checks/u)
    expect(summary.recorded).toEqual([])
    expect(events.filter((event) => event.startsWith('bot-check'))).toHaveLength(2)
    expect(store.checkpoint.record.done).toEqual({})
  })

  it('writes the bot-check pause to disk before it waits the pause out', async () => {
    const store = memoryStore([group('sp:creep', CREEP)])
    const checkpoint = await store.readCheckpoint()
    const botCheck = new FxmError('BotCheck', 'Sign in to confirm you are not a bot')
    const { providers } = fakeYouTube({ failures: [botCheck] })
    const { budget, events } = fakeBudget({ checkpoint, stored: () => store.checkpoint })
    const lines: string[] = []
    const summary = await recordGroups({
      providers,
      ctx,
      budget,
      store,
      checkpoint,
      sleep: noSleep,
      log: (line) => lines.push(line),
    })
    expect(summary.recorded).toEqual(['sp:creep'])
    const pause = JSON.stringify({ pausedUntil: 1_800_000, pauseLevel: 1 })
    expect(events.slice(0, 3)).toEqual([
      'wait',
      'bot-check:login-required',
      `wait (stored ${pause})`,
    ])
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^bot check 1 of 2 on isrc-songs.*paused until 1970-01-01T00:30/u),
        'bulk work is paused until 1970-01-01T00:30:00.000Z; waiting',
        'bulk work resumed',
      ]),
    )
  })

  it('defers a group whose page keeps failing, and records a page YouTube does not have', async () => {
    const network = new FxmError('Network', 'offline')
    const store = memoryStore([group('sp:creep', CREEP)])
    const { providers } = fakeYouTube({ failures: [network, network, network] })
    const summary = await recordGroups({
      providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(summary.deferred).toEqual(['sp:creep'])
    expect(store.checkpoint.record.deferred['sp:creep']).toMatchObject({ attempts: 1 })

    const missing = memoryStore([group('sp:creep', CREEP)])
    const gone = fakeYouTube({ failures: [new FxmError('NotFound', 'gone')] })
    await recordGroups({
      providers: gone.providers,
      ctx,
      budget: fakeBudget().budget,
      store: missing,
      sleep: noSleep,
    })
    const saved = await missing.readGroup('sp:creep')
    expect(saved?.recording?.pages['isrc-songs/1/GBAYE9200070']).toEqual({ error: 'NotFound' })
  })

  it('defers a page the parsers cannot read instead of filing it as failed', async () => {
    const parse = new FxmError('Parse', 'YouTube refused the request')
    const store = memoryStore([group('sp:creep', CREEP)])
    const { providers } = fakeYouTube({ failures: [parse, parse, parse] })
    const summary = await recordGroups({
      providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(summary.deferred).toEqual(['sp:creep'])
    const saved = await store.readGroup('sp:creep')
    expect(saved?.recording?.pages['isrc-songs/1/GBAYE9200070']).toBeUndefined()
  })

  it('stops the run when groups fail one after another', async () => {
    const ids = ['sp:a', 'sp:b', 'sp:c', 'sp:d']
    const store = memoryStore(ids.map((id) => group(id, CREEP)))
    const parse = new FxmError('Parse', 'YouTube refused the request')
    const { providers, calls } = fakeYouTube({ failures: Array.from({ length: 12 }, () => parse) })
    const summary = await recordGroups({
      providers,
      ctx,
      budget: fakeBudget().budget,
      store,
      sleep: noSleep,
    })
    expect(summary.deferred).toEqual(['sp:a', 'sp:b', 'sp:c'])
    expect(summary.stopped).toMatch(/3 groups in a row failed/u)
    expect(calls).toHaveLength(9)
    expect(summary.remaining).toBe(4)
    expect(Object.keys(store.checkpoint.record.deferred)).toEqual(['sp:a', 'sp:b', 'sp:c'])
  })

  it('records what the replay needs: every recording option replays without a missing page', async () => {
    const store = memoryStore([group('sp:creep', { ...CREEP, isrc: 'USZZZ9999999' })])
    const { providers } = fakeYouTube()
    await recordGroups({ providers, ctx, budget: fakeBudget().budget, store, sleep: noSleep })
    const saved = await store.readGroup('sp:creep')
    const recording = saved?.recording
    expect(recording).toBeDefined()
    if (saved === undefined || recording === undefined) return
    for (const variant of saved.variants) {
      for (const options of matchingEval.RECORDING_OPTIONS) {
        const replay = matchingEval.replayMatch(variant.source, recording, options)
        expect(replay.unrecorded, `${variant.slice}`).toEqual([])
      }
    }
  })
})
