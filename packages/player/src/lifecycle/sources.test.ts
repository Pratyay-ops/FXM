import { formatId, playbackProblemOf } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testTrack } from '../testing/fixtures'
import { playRequest, setup, useFakeClock } from './test-harness'
import { FakeStreamSource } from './testing/fake-stream-source'

beforeEach(() => {
  useFakeClock()
  // A lifecycle without a player warns once; these tests call it directly.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A song of a runtime plugin's catalog (stage 8.3), which has audio of its own. */
const pluginSong = testTrack('p1', {
  id: formatId('plugin.radio', 'track', 'p1'),
  source: 'plugin.radio',
})

function itemOf(track: typeof pluginSong) {
  return { uid: 1, track }
}

describe('stream sources added later', () => {
  it('resolve the tracks of their source until they are removed', async () => {
    const { lifecycle } = setup({ attach: false })
    const before = await lifecycle.resolve(itemOf(pluginSong), playRequest()).catch((e) => e)
    expect(playbackProblemOf(before)).toMatchObject({ type: 'unavailable', reason: 'no-source' })

    const radio = new FakeStreamSource({
      id: 'plugin.radio',
      expires: false,
      now: () => Date.now(),
    })
    const remove = lifecycle.addSource(radio)
    const resolved = await lifecycle.resolve(itemOf(pluginSong), playRequest())
    expect(resolved.stream.url).toMatch(/^https:\/\/plugin\.radio\.test\/p1\//u)
    expect(radio.log).toEqual(['p1:top'])

    // Gone at once: a URL it resolved before isn't served from the cache either.
    remove()
    const after = await lifecycle.resolve(itemOf(pluginSong), playRequest()).catch((e) => e)
    expect(playbackProblemOf(after)).toMatchObject({ type: 'unavailable', reason: 'no-source' })
  })

  it('replace a source with the same id, and leave it when an older one is removed', async () => {
    const { lifecycle } = setup({ attach: false })
    const first = new FakeStreamSource({
      id: 'plugin.radio',
      expires: false,
      now: () => Date.now(),
    })
    const second = new FakeStreamSource({
      id: 'plugin.radio',
      host: 'second.test',
      expires: false,
      now: () => Date.now(),
    })
    const removeFirst = lifecycle.addSource(first)
    lifecycle.addSource(second)
    removeFirst()
    const resolved = await lifecycle.resolve(itemOf(pluginSong), playRequest())
    expect(resolved.stream.url).toMatch(/^https:\/\/second\.test\//u)
    expect(first.log).toEqual([])
  })
})
