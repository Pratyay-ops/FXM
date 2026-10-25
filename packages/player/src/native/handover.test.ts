import { FxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { EngineError } from '../engine'
import { testTracks } from '../testing/fixtures'
import { nativeSetup, settle } from './test-harness'

/** The calls after `from`, without the volume ones. */
function callsSince(calls: readonly string[], from: number): string[] {
  return calls.slice(from).filter((call) => !call.startsWith('setVolume'))
}

/** A connected player playing `a` of the given queue, with Media3 queued up. */
async function playing(...titles: string[]) {
  const setup = nativeSetup()
  await setup.connect()
  await setup.player.setQueue(testTracks(...titles))
  await settle()
  setup.plugin.ready()
  await settle()
  return setup
}

describe('crossing a track boundary in Media3', () => {
  it('lets the facade follow without pausing or loading anything', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    expect(plugin.entries.map((entry) => entry.metadata.title)).toEqual(['a', 'b', 'c'])
    const causes: string[] = []
    player.on('trackchange', ({ cause }) => causes.push(cause))
    const from = plugin.calls.length
    plugin.advance()
    await settle()
    expect(current()).toBe('b')
    expect(causes).toEqual(['ended'])
    expect(player.getState().status).toBe('playing')
    const calls = callsSince(plugin.calls, from)
    expect(calls.some((call) => call === 'pause' || call.startsWith('load'))).toBe(false)
    // The queue's tail moves along.
    expect(calls).toContain('setUpcoming:[c]')
  })

  it('takes over the position Media3 reached meanwhile', async () => {
    const { plugin, player } = await playing('a', 'b')
    plugin.advance()
    plugin.progress(2_500, 200_000)
    await settle()
    expect(player.getState()).toMatchObject({ positionMs: 2_500, durationMs: 200_000 })
  })

  it('follows through every entry Media3 played while the page was busy', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c', 'd')
    const changes: string[] = []
    player.on('trackchange', ({ item, cause }) => changes.push(`${item?.track.title}:${cause}`))
    const from = plugin.calls.length
    plugin.advance()
    plugin.advance()
    await settle()
    expect(current()).toBe('c')
    expect(changes).toEqual(['b:ended', 'c:ended'])
    expect(player.getState().status).toBe('playing')
    expect(callsSince(plugin.calls, from).some((call) => call.startsWith('load'))).toBe(false)
  })

  it('switches Media3 to the facade’s item when the queue changed at the boundary', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    const from = plugin.calls.length
    // The user removes b just as Media3 starts it, before the queue's tail reached Media3.
    player.remove(1)
    plugin.advance()
    await settle()
    expect(current()).toBe('c')
    const calls = callsSince(plugin.calls, from)
    expect(calls).toContain('pause')
    expect(calls).toContain('load:c@0+[]')
  })

  it('stops Media3 when the facade’s queue ended', async () => {
    const { plugin, player } = await playing('a', 'b')
    player.remove(1)
    plugin.advance()
    await settle()
    expect(player.getState().status).toBe('ended')
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('pauses Media3 when the user paused while the facade caught up', async () => {
    const { plugin, player, current } = await playing('a', 'b')
    plugin.advance()
    // The facade is still resolving b.
    player.pause()
    await settle()
    expect(current()).toBe('b')
    expect(player.getState().status).toBe('paused')
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('reports a failure of the entry Media3 moved to, once the facade has it', async () => {
    const { plugin, player, resolver } = await playing('a', 'b')
    plugin.advance()
    plugin.fail({ status: 410 })
    await settle()
    const retry = resolver.requestsFor('b').find((request) => request.reason === 'retry')
    expect(retry?.failure?.error).toMatchObject({ type: 'network' } satisfies Partial<EngineError>)
    expect(plugin.calls.filter((call) => call.startsWith('load:b'))).toHaveLength(1)
    expect(player.getState().queue.index).toBe(1)
  })

  it('lets Media3 loop a track on repeat one, without seeking it back', async () => {
    const { plugin, player } = await playing('a', 'b')
    player.setRepeat('one')
    await settle()
    expect(plugin.repeat).toBe('one')
    const seeks: string[] = []
    player.on('seek', ({ cause }) => seeks.push(cause))
    const from = plugin.calls.length
    plugin.repeatRound()
    await settle()
    expect(seeks).toEqual(['repeat'])
    expect(callsSince(plugin.calls, from).some((call) => call.startsWith('seek'))).toBe(false)
    expect(player.getState().status).toBe('playing')
  })

  it('hands the system’s next and previous to the facade', async () => {
    const { plugin, player, current } = await playing('a', 'b', 'c')
    const causes: string[] = []
    player.on('trackchange', ({ cause }) => causes.push(cause))
    plugin.command('next')
    await settle()
    expect(plugin.calls).toContain('ack')
    expect(current()).toBe('b')
    plugin.ready()
    plugin.command('previous')
    await settle()
    expect(current()).toBe('a')
    expect(causes).toEqual(['next', 'previous'])
  })

  it('skips to a queued entry by its id, so Media3 keeps its buffer', async () => {
    const { plugin, player } = await playing('a', 'b', 'c')
    const queued = plugin.entries[1]?.id
    await player.next()
    expect(plugin.entries[0]?.id).toBe(queued)
  })

  it('pauses Media3 when the facade stops for good', async () => {
    const { plugin, player, resolver } = await playing('a', 'b')
    resolver.handler = () => {
      throw new FxmError('BotCheck', 'Sign in to confirm you’re not a bot')
    }
    plugin.fail({ status: 403 })
    await settle()
    expect(player.getState()).toMatchObject({
      status: 'error',
      error: { reason: 'action-required' },
    })
    expect(plugin.state.playWhenReady).toBe(false)
  })

  it('releases Media3 when the queue is emptied', async () => {
    const { plugin, player } = await playing('a', 'b')
    await player.setQueue([])
    await settle()
    expect(plugin.calls).toContain('release')
    expect(plugin.entries).toEqual([])
  })
})
