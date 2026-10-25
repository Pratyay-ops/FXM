import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { usePlayerStore } from '../../features/player/player-store'
import { useSettingsStore } from '../../features/settings/settings-store'
import { bindPlayerBar, createInterimPlayer, type InterimPlayer } from './player'

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

function fakePlayer() {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver })
  disposers.push(() => player.destroy())
  return { engine, player }
}

/** Lets the player's async work settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('bindPlayerBar', () => {
  it("makes the bar's controls drive the player", async () => {
    const { player } = fakePlayer()
    disposers.push(bindPlayerBar(player))
    await player.setQueue(testTracks('a', 'b', 'c'))

    usePlayerStore.getState().next()
    await settle()
    expect(player.getState().queue.index).toBe(1)

    usePlayerStore.getState().togglePlay()
    await settle()
    expect(player.getState().status).toBe('paused')

    usePlayerStore.getState().toggleShuffle()
    usePlayerStore.getState().cycleRepeat()
    expect(player.getState().queue.shuffle).toBe(true)
    expect(player.getState().queue.repeat).toBe('all')

    usePlayerStore.getState().setVolume(0)
    expect(player.getState().muted).toBe(true)
    usePlayerStore.getState().toggleMute()
    expect(player.getState()).toMatchObject({ muted: false, volume: 0.5 })
  })

  it('shows what the player does, in the units the bar shows', async () => {
    const { player, engine } = fakePlayer()
    disposers.push(bindPlayerBar(player))
    await player.setQueue(testTracks('a'))

    engine.progress(42_000)

    expect(usePlayerStore.getState()).toMatchObject({ isPlaying: true, position: 42 })
    player.pause()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('puts the placeholder back when unbound', () => {
    const { player } = fakePlayer()
    const placeholder = usePlayerStore.getState()

    const unbind = bindPlayerBar(player)
    expect(usePlayerStore.getState().next).not.toBe(placeholder.next)
    unbind()

    expect(usePlayerStore.getState().next).toBe(placeholder.next)
  })
})

describe('createInterimPlayer', () => {
  let interim: InterimPlayer | undefined

  afterEach(() => {
    interim?.dispose()
    interim = undefined
  })

  it('plays in the catalog mode of the settings, and follows it', () => {
    useSettingsStore.setState({ catalogMode: 'all' })
    interim = createInterimPlayer({
      resolver: new FakeResolver(),
      engine: new FakeEngine(),
      mediaSession: false,
    })
    expect(interim.player.getState().queue.mode).toBe('all')

    useSettingsStore.setState({ catalogMode: 'music' })

    expect(interim.player.getState().queue.mode).toBe('music')
  })

  it('stops following the settings and the bar once disposed', () => {
    const engine = new FakeEngine()
    interim = createInterimPlayer({
      resolver: new FakeResolver(),
      engine,
      mediaSession: false,
    })
    const placeholderNext = usePlayerStore.getInitialState().next

    interim.dispose()
    interim = undefined

    expect(engine.destroyed).toBe(true)
    expect(usePlayerStore.getState().next).toBe(placeholderNext)
  })
})
