/**
 * Fakes for the stream lifecycle's touch-points, for its own tests and for later stages that
 * drive it: a stream source shaped like the YouTube ladder, a matching engine, a network
 * monitor, and fixtures. Re-exported from `@fxm/player/testing`.
 *
 * @module
 */

export { FakeMatcher, type FakeMatcherCall, type RankedCandidate } from './fake-matcher'
export { FakeNetworkMonitor } from './fake-network'
export {
  FAKE_URL_LIFETIME_MS,
  FakeStreamSource,
  type FakeStreamSourceCall,
  type FakeStreamSourceOptions,
  type LadderStreamsOptions,
  ladderStreams,
} from './fake-stream-source'
export { TEST_CAPABILITIES, testCandidate, testContext, testSpotifyTrack } from './fixtures'
