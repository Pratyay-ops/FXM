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
  isStoredMatch,
  type MatchKey,
  type MatchOutcome,
  type MatchRequest,
  type MatchStore,
  type MemoryMatchStore,
  matchKeyString,
  type OfflineStore,
  type ResolvePriority,
  type StoredMatch,
  type StreamSource,
  type StreamSourceRequest,
  type TrackMatcher,
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
