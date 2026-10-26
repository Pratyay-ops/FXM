/**
 * Test helpers for code that drives the player: `@fxm/player/testing`. Nothing here touches a
 * real audio element or the network.
 *
 * @module
 */

export * from '../lifecycle/testing'
export {
  FakeAudioContext,
  FakeNode,
  FakeParam,
  type RenderSignals,
} from './fake-audio-context'
export { FakeEngine, type FakeEngineCall } from './fake-engine'
export { createFakeFxmPlayer, type FakeFxmPlayer } from './fake-fxm-player'
export { FakeResolver, type FakeResolverRequest, type ResolveHandler } from './fake-resolver'
export { testStream, testTrack, testTracks } from './fixtures'
