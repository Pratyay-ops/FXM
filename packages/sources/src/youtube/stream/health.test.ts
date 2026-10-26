import { describe, expect, it } from 'vitest'
import { RungHealthBook, type RungHealthStore } from './health'

const NOW = Date.UTC(2026, 9, 26, 12)
const MINUTE = 60_000

function book(store?: RungHealthStore, rungs?: () => readonly string[]) {
  let time = NOW
  const health = new RungHealthBook({
    now: () => time,
    ...(store === undefined ? {} : { store }),
    ...(rungs === undefined ? {} : { rungs }),
  })
  return {
    health,
    advance(ms: number) {
      time += ms
    },
  }
}

describe('rung health', () => {
  it('cools a failed rung down for 5 minutes, doubling up to an hour, until it works', () => {
    const { health, advance } = book()
    const coolDowns: number[] = []
    for (let failure = 0; failure < 6; failure += 1) {
      health.fail('web/full', 'visionos', 'bot-check')
      coolDowns.push(((health.coolingUntil('web/full', 'visionos') ?? NOW) - NOW) / MINUTE)
    }
    expect(coolDowns).toEqual([5, 10, 20, 40, 60, 60])
    advance(60 * MINUTE)
    expect(health.coolingUntil('web/full', 'visionos')).toBeUndefined()
    health.fail('web/full', 'visionos', 'capped')
    expect(health.coolingUntil('web/full', 'visionos')).toBe(NOW + 120 * MINUTE)
    health.succeed('web/full', 'visionos')
    expect(health.coolingUntil('web/full', 'visionos')).toBeUndefined()
    expect(health.snapshot('web/full', ['visionos', 'ios'])).toEqual({
      scope: 'web/full',
      lastWorking: 'visionos',
      lastWorkingAt: NOW + 60 * MINUTE,
      rungs: [
        {
          rung: 'visionos',
          successes: 1,
          failures: 7,
          consecutiveFailures: 0,
          lastSuccessAt: NOW + 60 * MINUTE,
          lastFailureAt: NOW + 60 * MINUTE,
          lastFailure: 'capped',
        },
        { rung: 'ios', successes: 0, failures: 0, consecutiveFailures: 0 },
      ],
    })
  })

  it('keeps platforms and tiers apart', () => {
    const { health } = book()
    health.fail('web/simple', 'visionos', 'playback')
    expect(health.coolingUntil('web/simple', 'visionos')).toBeDefined()
    expect(health.coolingUntil('web/full', 'visionos')).toBeUndefined()
    expect(health.snapshot('android/full', ['visionos']).lastWorking).toBeUndefined()
  })

  it('saves to its store and loads from it', async () => {
    let saved: unknown
    const store: RungHealthStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }
    const first = book(store).health
    await first.ready()
    first.succeed('desktop/full', 'android-muxed')
    first.fail('desktop/full', 'visionos', 'bot-check')
    await first.settled()
    const second = book(store).health
    await second.ready()
    expect(second.snapshot('desktop/full', ['visionos', 'android-muxed'])).toEqual(
      first.snapshot('desktop/full', ['visionos', 'android-muxed']),
    )
  })

  it('keeps what was recorded before the store finished loading', async () => {
    const stored = {
      v: 1,
      scopes: {
        'web/full': { w: 'android-muxed', wa: NOW, r: { 'android-muxed': { s: 3, f: 0, c: 0 } } },
        'desktop/full': { r: { visionos: { s: 1, f: 0, c: 0, ls: NOW } } },
      },
    }
    const { health } = book({ load: async () => stored, save: () => {} })
    health.fail('web/full', 'visionos', 'playback')
    await health.ready()
    const web = health.snapshot('web/full', ['visionos', 'android-muxed'])
    expect(web.lastWorking).toBe('android-muxed')
    expect(web.rungs.map((rung) => [rung.rung, rung.successes, rung.failures])).toEqual([
      ['visionos', 0, 1],
      ['android-muxed', 3, 0],
    ])
    expect(health.snapshot('desktop/full', ['visionos']).rungs[0]?.successes).toBe(1)
  })

  it('never overwrites the stored state with what it recorded before loading it', async () => {
    let saved: unknown = {
      v: 1,
      scopes: {
        'android/full': {
          w: 'android-muxed',
          wa: NOW,
          r: { 'android-muxed': { s: 40, f: 0, c: 0 } },
        },
        'web/full': { r: { visionos: { s: 2, f: 0, c: 0 } } },
      },
    }
    let release = () => {}
    const loaded = new Promise<void>((resolve) => {
      release = resolve
    })
    const store: RungHealthStore = {
      load: async () => {
        await loaded
        return structuredClone(saved)
      },
      save: (state) => {
        saved = state
      },
    }
    const { health } = book(store)
    // A playback report about a URL kept from before, ahead of the first resolution.
    health.fail('web/full', 'visionos', 'playback')
    void health.ready()
    release()
    await health.settled()
    const restarted = book(store).health
    await restarted.ready()
    expect(restarted.snapshot('android/full', ['android-muxed']).rungs[0]?.successes).toBe(40)
    expect(restarted.snapshot('web/full', ['visionos']).rungs[0]).toMatchObject({
      successes: 2,
      failures: 1,
    })
  })

  it('ignores a failure time ahead of the clock instead of cooling a rung down until then', async () => {
    const ahead = NOW + 365 * 24 * 60 * MINUTE
    const stored = {
      v: 1,
      scopes: {
        'web/full': {
          w: 'visionos',
          wa: ahead,
          r: { visionos: { s: 1, f: 3, c: 3, ls: ahead, lf: ahead, k: 'capped' } },
        },
      },
    }
    const loaded = book({ load: () => stored, save: () => {} })
    await loaded.health.ready()
    expect(loaded.health.coolingUntil('web/full', 'visionos')).toBeUndefined()
    expect(loaded.health.snapshot('web/full', ['visionos'])).toEqual({
      scope: 'web/full',
      lastWorking: 'visionos',
      rungs: [
        {
          rung: 'visionos',
          successes: 1,
          failures: 3,
          consecutiveFailures: 3,
          lastFailure: 'capped',
        },
      ],
    })
    // The same for a failure recorded while the clock was ahead, once it is set back.
    const { health, advance } = book()
    advance(365 * 24 * 60 * MINUTE)
    health.fail('web/full', 'visionos', 'bot-check')
    advance(-365 * 24 * 60 * MINUTE)
    expect(health.coolingUntil('web/full', 'visionos')).toBeUndefined()
  })

  it('forgets rungs the config no longer lists', async () => {
    let saved: unknown = {
      v: 1,
      scopes: {
        'web/full': {
          w: 'tv-old',
          wa: NOW,
          r: { 'tv-old': { s: 9, f: 0, c: 0 }, visionos: { s: 1, f: 0, c: 0 } },
        },
      },
    }
    const store: RungHealthStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }
    const { health } = book(store, () => ['visionos', 'android-muxed'])
    await health.ready()
    expect(health.snapshot('web/full', ['visionos']).lastWorking).toBeUndefined()
    health.succeed('web/full', 'android-muxed')
    await health.settled()
    expect(saved).toEqual({
      v: 1,
      scopes: {
        'web/full': {
          w: 'android-muxed',
          wa: NOW,
          r: { visionos: { s: 1, f: 0, c: 0 }, 'android-muxed': { s: 1, f: 0, c: 0, ls: NOW } },
        },
      },
    })
  })

  it('treats a rung named like an object property as any other', async () => {
    let saved: unknown
    const store: RungHealthStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }
    const { health } = book(store)
    health.fail('web/full', 'constructor', 'capped')
    expect(health.coolingUntil('web/full', 'constructor')).toBe(NOW + 5 * MINUTE)
    health.succeed('web/full', 'visionos')
    await health.settled()
    const restarted = book(store).health
    await restarted.ready()
    expect(restarted.snapshot('web/full', ['constructor', 'visionos'])).toMatchObject({
      lastWorking: 'visionos',
      rungs: [
        { rung: 'constructor', failures: 1, consecutiveFailures: 1 },
        { rung: 'visionos', successes: 1 },
      ],
    })
  })

  it('keeps the entries it can trust next to ones it cannot', async () => {
    const stored = {
      v: 1,
      scopes: {
        'web/full': {
          w: 'visionos',
          r: { visionos: { s: 4, f: 0, c: 0 }, 'android-muxed': { s: -1, f: 0, c: 0 } },
        },
        'Web/Full': { r: { visionos: { s: 1, f: 0, c: 0 } } },
        'desktop/full': { r: { BAD: { s: 1, f: 0, c: 0 }, visionos: { s: 2, f: 0, c: 0 } } },
      },
    }
    const { health } = book({ load: () => stored, save: () => {} })
    await health.ready()
    expect(health.snapshot('web/full', ['visionos', 'android-muxed'])).toMatchObject({
      lastWorking: 'visionos',
      rungs: [{ successes: 4 }, { successes: 0 }],
    })
    expect(health.snapshot('desktop/full', ['visionos']).rungs[0]?.successes).toBe(2)
  })

  it('starts empty from a stored state it cannot trust', async () => {
    const entry = { s: 1, f: 0, c: 0 }
    const broken: unknown[] = [
      undefined,
      'x',
      { v: 2, scopes: {} },
      { v: 1, scopes: null },
      { v: 1, scopes: { 'Web/Full': { r: {} } } },
      { v: 1, scopes: { 'web/full': 'x' } },
      { v: 1, scopes: { 'web/full': { w: 7, r: {} } } },
      { v: 1, scopes: { 'web/full': { w: 'Bad Rung', r: {} } } },
      { v: 1, scopes: { 'web/full': { wa: -1, r: {} } } },
      { v: 1, scopes: { 'web/full': {} } },
      { v: 1, scopes: { 'web/full': { r: { BAD: entry } } } },
      { v: 1, scopes: { 'web/full': { r: { visionos: null } } } },
      { v: 1, scopes: { 'web/full': { r: { visionos: { ...entry, s: 1.5 } } } } },
      { v: 1, scopes: { 'web/full': { r: { visionos: { ...entry, ls: 'x' } } } } },
      { v: 1, scopes: { 'web/full': { r: { visionos: { ...entry, lf: Number.NaN } } } } },
      { v: 1, scopes: { 'web/full': { r: { visionos: { ...entry, k: 'toString' } } } } },
      {
        v: 1,
        scopes: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`web/t${'x'.repeat(i)}`, { r: {} }]),
        ),
      },
    ]
    for (const value of broken) {
      const { health } = book({ load: () => value, save: () => {} })
      await health.ready()
      expect(
        health.snapshot('web/full', ['visionos']).rungs[0]?.successes,
        JSON.stringify(value),
      ).toBe(0)
    }
  })

  it('works in memory when its store fails', async () => {
    const { health } = book({
      load: () => {
        throw new Error('blocked')
      },
      save: () => {
        throw new Error('quota')
      },
    })
    await health.ready()
    health.succeed('web/full', 'visionos')
    expect(health.snapshot('web/full', ['visionos']).lastWorking).toBe('visionos')
  })
})
