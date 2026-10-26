/**
 * The experimental YouTube rungs (stage 1.11): deciphered, attested and SABR. They are shipped
 * off in `youtube-config.json`; see `README.md` in this folder.
 *
 * @module
 */

export {
  BOTGUARD_REQUEST_KEY,
  consentRedirect,
  GENERATE_IT_URL,
  INTERPRETER_PREFIX,
  type PageChallenge,
  parsePageChallenge,
  WebPoTokens,
  type WebPoTokensOptions,
  YOUTUBE_HOME_URL,
} from './botguard'
export { type CipheredUrl, cipheredUrlOf, DECIPHER_PROCESSOR, decipherUrls } from './decipher'
export {
  ATTESTATION_ORIGIN,
  evaluatorCodeOf,
  isEvaluatorDown,
  type StreamEvaluator,
  type StreamEvaluatorCallOptions,
} from './evaluator'
export type { AdvancedPlayerCall, AdvancedRungs } from './hook'
export {
  ADVANCED_RUNG_KIND_NAMES,
  ADVANCED_RUNG_READERS,
  type AdvancedRungKindName,
  advancedRungKinds,
} from './kinds'
export {
  extractWithYoutubei,
  IFRAME_API_URL,
  PLAYER_SCRIPT_PREFIX,
  type PlayerScript,
  type PlayerScriptExtractor,
  type PlayerScriptStore,
  PlayerScripts,
  type PlayerScriptsOptions,
  playerIdOf,
} from './player-script'
export {
  type AdvancedRungsHook,
  type AdvancedRungsOptions,
  createAdvancedRungs,
  EVALUATOR_RETRY_MS,
} from './rungs'
export {
  CLIENT_NAME_IDS,
  SABR_PLAYBACK_FORMAT,
  type SabrFormatJson,
  type SabrSession,
  sabrFormatOf,
  sabrStreamOptions,
  type YouTubeSabrPlayback,
} from './sabr'
