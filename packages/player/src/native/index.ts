/**
 * The native engine (stage 6.3): the player facade on the Android app's Media3 player, through
 * the `FxmPlayer` Capacitor plugin. See `README.md` in this folder. The entry builders stay
 * internal; the plugin's types are here for a custom plugin or a fake.
 *
 * @module
 */

export {
  NATIVE_ENGINE_DEFAULTS,
  type NativeConnection,
  type NativeConnectOptions,
  NativeEngine,
  type NativeEngineOptions,
  type NativePlaybackPlayer,
} from './native-engine'
export {
  FXM_PLAYER_ERROR_CODES,
  FXM_PLAYER_MAX_ENTRY_DATA,
  FXM_PLAYER_MAX_UPCOMING,
  FXM_PLAYER_PLUGIN,
  type FxmPlayerEntry,
  type FxmPlayerErrorCode,
  type FxmPlayerEventMap,
  type FxmPlayerFailure,
  type FxmPlayerListenerHandle,
  type FxmPlayerLoadOptions,
  type FxmPlayerMetadata,
  type FxmPlayerNetwork,
  type FxmPlayerPlaybackState,
  type FxmPlayerPlugin,
  type FxmPlayerRepeat,
  type FxmPlayerSession,
  type FxmPlayerSource,
  type FxmPlayerState,
  type FxmPlayerUpcomingOptions,
  findFxmPlayerPlugin,
  fxmPlayerErrorCode,
} from './plugin'
