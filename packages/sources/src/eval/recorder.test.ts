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
import { type RecorderBudget, recordGroups } from './recorder'
import { memoryStore } from './store'

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

function group(id: string, source: MatchSource): EvalGroup {
  return {
    id,
    split: matchingEval.splitOf(id),
    categories: ['mainstream'],
    provenance: ['test'],
    variants: [
      { slice: 'spotify', source },
      {
        slice: 'data-export',
        source: { title: source.title, artists: source.artists, album: { name: 'Pablo Honey' } },
      },
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

function fakeBudget(script: { refusals?: number } = {}) {
  let refusals = script.refusals ?? 0
  const events: string[] = []
  const budget: RecorderBudget = {
    async whenAvailable() {
      events.push('wait')
    },
    reportBotCheck(cause) {
      events.push(`bot-check:${cause}`)
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
    expect(store.checkpoint.record.done).toEqual(['sp:creep'])
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
    expect(store.checkpoint.record.done).toEqual([])
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
