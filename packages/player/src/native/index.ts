/**
 * The native engine (stage 6.3): the player facade on the Android app's Media3 player, through
 * the `FxmPlayer` Capacitor plugin. See `README.md` in this folder.
 *
 * @module
 */

export {
  lockScreenArtwork,
  nativeEntry,
  nativeMetadata,
  nativeSource,
  nativeSupport,
} from './entries'
export {
  NATIVE_ENGINE_DEFAULTS,
  type NativeConnectOptions,
  NativeEngine,
  type NativeEngineOptions,
  type NativePlaybackPlayer,
} from './native-engine'
export {
  FXM_PLAYER_ERROR_CODES,
  FXM_PLAYER_MAX_UPCOMING,
  FXM_PLAYER_PLUGIN,
  type FxmPlayerErrorCode,
  type FxmPlayerEventMap,
  type FxmPlayerListenerHandle,
  type FxmPlayerPlugin,
  findFxmPlayerPlugin,
  type NativeEntry,
  type NativeFailure,
  type NativeLoadOptions,
  type NativeMetadata,
  type NativeNetwork,
  type NativePlaybackState,
  type NativeRepeat,
  type NativeSession,
  type NativeSource,
  type NativeState,
  type NativeUpcomingOptions,
} from './plugin'
