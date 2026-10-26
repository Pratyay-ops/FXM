/**
 * What the audio effects do to the track that plays, in words for Settings and the Sound dialog:
 * whether the equalizer can process it here and why not, and the loudness gain it plays at.
 *
 * @module
 */

import type { NetworkCapabilities, Platform } from '@fxm/core'
import type { AudioEffectsStatus } from '@fxm/player'

/** Where the app runs, as far as the notes depend on it. */
export interface StatusContext {
  readonly platform: Platform
  readonly capabilities: Pick<NetworkCapabilities, 'youtube' | 'mediaBytes'>
}

/** Where the equalizer always works on the web and in the desktop app. */
const READABLE_SOURCES = 'local files, downloads, Internet Archive and Jamendo'

/**
 * Why the equalizer can't process the track that plays, or `undefined` when it can (or is off,
 * or nothing plays).
 */
export function equalizerNote(
  status: AudioEffectsStatus,
  context: StatusContext,
): string | undefined {
  if (status.equalizer !== 'unavailable') return undefined
  if (context.platform === 'desktop') {
    return `Not available for this track: the desktop app can’t read YouTube audio for the equalizer yet. It works on ${READABLE_SOURCES}.`
  }
  if (context.platform === 'web' && context.capabilities.mediaBytes) {
    return 'Not available for this track: its audio couldn’t be read (the stream moved to another server, or the browser blocked Web Audio). The equalizer applies again from the next track.'
  }
  if (context.platform === 'web') {
    return `Not available for this track: without FXM Connect, FXM can’t read YouTube audio. It works on ${READABLE_SOURCES}.`
  }
  return 'Not available for this track here.'
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
