/**
 * Wiring for the native engine's tests: the real player facade on a {@link NativeEngine} over the
 * fake `FxmPlayer` plugin, with a fake resolver.
 *
 * @module
 */

import { currentQueueItem } from '@fxm/core'
import { Player, type PlayerOptions } from '../player'
import { createFakeFxmPlayer, type FakeFxmPlayerOptions } from '../testing/fake-fxm-player'
import { FakeResolver } from '../testing/fake-resolver'
import { type NativeConnectOptions, NativeEngine } from './native-engine'

/** Lets every pending promise, microtask and zero-delay timer run. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

export interface NativeSetup {
  plugin: ReturnType<typeof createFakeFxmPlayer>
  engine: NativeEngine
  resolver: FakeResolver
  player: Player
  /** The title of the player's current item. */
  current(): string | undefined
  /** Connects the engine to the player, as the app does. */
  connect(options?: Partial<NativeConnectOptions>): Promise<() => void>
}

/** A player on a native engine over a fake plugin. */
export function nativeSetup(
  options: {
    fake?: FakeFxmPlayerOptions
    player?: Partial<PlayerOptions>
    now?: () => number
  } = {},
): NativeSetup {
  const plugin = createFakeFxmPlayer(options.fake)
  const engine = new NativeEngine({
    plugin,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const resolver = new FakeResolver()
  const player = new Player({
    engine,
    resolver,
    stallTimeoutMs: 0,
    retryDelaysMs: [0],
    ...options.player,
  })
  return {
    plugin,
    engine,
    resolver,
    player,
    current: () => currentQueueItem(player.getState().queue)?.track.title,
    connect: (connect = {}) => engine.connect({ player, resolver, ...connect }),
  }
}
