/**
 * What the audio effects do to the track that plays, in words for Settings and the Sound dialog:
 * whether the equalizer can process it here and why not, and the loudness gain it plays at.
 *
 * @module
 */

import type { NetworkCapabilities, Platform } from '@fxm/core'
import { CONNECT_REDIRECT_FIX_VERSION, needsRedirectFix } from '@fxm/platform'
import type { AudioEffectsStatus } from '@fxm/player'
import { freeSources } from '../../lib/free-sources'

/** Where the app runs, as far as the notes depend on it. */
export interface StatusContext {
  readonly platform: Platform
  readonly capabilities: Pick<NetworkCapabilities, 'youtube' | 'mediaBytes'>
  /** The version of FXM Connect the page found, if any. */
  readonly connectVersion?: string
}

/**
 * Where the equalizer always works on the web and in the desktop app: the user's files and the
 * free sources this build offers (`freeSources()`, which names Jamendo only where it is offered).
 */
function readableSources(): string {
  const free = freeSources()
  return free.several
    ? `local files, downloads, ${free.and}`
    : `local files, downloads and ${free.and}`
}

/** Why the equalizer can't read the track's audio where FXM runs (`unreadable`). */
function unreadableNote(context: StatusContext): string {
  if (context.platform === 'desktop') {
    return `Not available for this track: the desktop app can’t read YouTube audio for the equalizer yet. It works on ${readableSources()}.`
  }
  if (context.platform === 'android') {
    return `Not available for this track: the Android app can’t read YouTube audio for the equalizer yet. It works on ${readableSources()}.`
  }
  if (context.platform === 'web' && context.capabilities.mediaBytes) {
    return `Not available for this track: FXM can’t read audio from its source. It works on YouTube, ${readableSources()}.`
  }
  if (context.platform === 'web') {
    return `Not available for this track: without FXM Connect, FXM can’t read YouTube audio. It works on ${readableSources()}.`
  }
  return 'Not available for this track here.'
}

/**
 * Why reading the track's audio failed, although it should have worked (`read-failed`): in a
 * browser with FXM Connect, an FXM Connect older than {@link CONNECT_REDIRECT_FIX_VERSION} can't
 * read YouTube audio that googlevideo moved to another server; otherwise the browser didn't let it.
 */
function readFailedNote(context: StatusContext): string {
  if (context.platform !== 'web' || !context.capabilities.mediaBytes) {
    return 'Not available for this track: its audio couldn’t be read.'
  }
  const version = context.connectVersion
  if (version !== undefined && needsRedirectFix(version)) {
    return `Not available for this track: FXM Connect ${version} couldn’t read its audio, which happens when YouTube moves a song to another server. Update FXM Connect to ${CONNECT_REDIRECT_FIX_VERSION}.`
  }
  return `Not available for this track: this browser didn’t let FXM Connect read its audio. It works on ${readableSources()}.`
}

/**
 * Why the equalizer can't process the track that plays, or `undefined` when it can (or is off,
 * or nothing plays): by the engine's reason (`equalizerReason`) and where FXM runs.
 */
export function equalizerNote(
  status: AudioEffectsStatus,
  context: StatusContext,
): string | undefined {
  if (status.equalizer !== 'unavailable') return undefined
  switch (status.equalizerReason) {
    case 'suspended':
      return 'The equalizer starts with your next tap or click in FXM, such as Play or Pause: until then the browser holds sound effects back.'
    case 'no-web-audio':
      return 'Not available here: this browser doesn’t let FXM process sound.'
    case 'read-failed':
      return readFailedNote(context)
    default:
      return unreadableNote(context)
  }
}

/** A gain in dB as people read it: "3.9 dB quieter", "2 dB louder". */
export function describeGain(gainDb: number): string {
  const rounded = Math.round(Math.abs(gainDb) * 10) / 10
  if (rounded === 0) return 'at its own level'
  return `${rounded} dB ${gainDb < 0 ? 'quieter' : 'louder'}`
}

/** What loudness normalization does to the track that plays, or `undefined` while it is off. */
export function loudnessNote(status: AudioEffectsStatus): string | undefined {
  switch (status.loudness) {
    case 'on':
      return `This track plays ${describeGain(status.loudnessGainDb)}.`
    case 'no-data':
      return 'This track doesn’t say how loud it is, so it plays as it is.'
    case 'unavailable':
      return 'This device doesn’t let FXM change the volume, so tracks play as they are.'
    default:
      return undefined
  }
}

/** A speed as people read it: "1×", "1.25×". */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

/** What differs from normal in the Sound dialog, as the buttons that open it show it. */
export interface SoundChanges {
  /** The playback speed, 1 being normal. */
  readonly rate: number
  /** Whether the equalizer is on. */
  readonly equalizer: boolean
  /** Whether a sleep timer runs. */
  readonly sleepTimer: boolean
}

/**
 * The name of a button that opens the Sound dialog: "Sound", and what differs from normal, e.g.
 * "Sound: 1.25× speed, equalizer on, sleep timer on", which the button shows by its highlight.
 */
export function soundLabel({ rate, equalizer, sleepTimer }: SoundChanges): string {
  const changes = [
    ...(rate === 1 ? [] : [`${formatRate(rate)} speed`]),
    ...(equalizer ? ['equalizer on'] : []),
    ...(sleepTimer ? ['sleep timer on'] : []),
  ]
  return changes.length === 0 ? 'Sound' : `Sound: ${changes.join(', ')}`
}

/** A crossfade length as people read it: "Off", "6 s". */
export function formatCrossfade(durationMs: number): string {
  return durationMs <= 0 ? 'Off' : `${Math.round(durationMs / 1000)} s`
}

/** A band's frequency as people read it: "31 Hz", "1 kHz", "16 kHz". */
export function formatBand(frequencyHz: number): string {
  return frequencyHz >= 1000 ? `${frequencyHz / 1000} kHz` : `${frequencyHz} Hz`
}

/** A band's gain as people read it: "+2.5 dB", "0 dB", "−3 dB". */
export function formatGain(gainDb: number): string {
  if (gainDb === 0) return '0 dB'
  return `${gainDb > 0 ? '+' : '−'}${Math.abs(gainDb)} dB`
}

/** The time a sleep timer has left, as `m:ss` or `h:mm:ss`. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
