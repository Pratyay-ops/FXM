/**
 * The stream lifecycle (stage 2.3): the player's real `StreamResolver`, and the interfaces it
 * needs from the stream resolvers, the matching engine, the match cache and the network. See
 * `README.md` in this folder.
 *
 * @module
 */

export {
  createMemoryMatchStore,
  fromAudioSource,
  type MatchKey,
  type MatchOutcome,
  type MatchStore,
  type MemoryMatchStore,
  matchKeyString,
  type OfflineStore,
  type ResolvePriority,
  type StoredMatch,
  type StreamFailureReport,
  type StreamSource,
  type StreamSourceRequest,
  sanitizeStoredMatch,
  type TrackMatcher,
  type TrackMatchRequest,
} from './adapters'
export {
  type BrowserNetworkMonitorOptions,
  type ConnectionLike,
  createBrowserNetworkMonitor,
  createStaticNetworkMonitor,
  type DisposableNetworkMonitor,
  type NetworkMonitor,
} from './network'
export {
  type FlushReason,
  LIFECYCLE_DEFAULTS,
  type LifecycleEventMap,
  type LifecyclePlayer,
  type ReviewItem,
  StreamLifecycle,
  type StreamLifecycleOptions,
} from './stream-lifecycle'
