/**
 * Which of YouTube's audio codecs this browser plays, asked as the player's engine asks
 * (`canPlayType` for the stream's `mimeTypeOf`), so the quality settings say what each tier
 * really streams here.
 *
 * @module
 */

import { mimeTypeOf } from '@fxm/player'

/** The codecs of YouTube's audio streams: Opus in WebM (251, 250, 249), AAC in MP4 (140, 139). */
export type YouTubeCodec = 'opus' | 'aac'

const TYPES: Readonly<Record<YouTubeCodec, string>> = {
  opus: mimeTypeOf({ codec: 'opus', container: 'webm' }) ?? 'audio/webm; codecs="opus"',
  aac: mimeTypeOf({ codec: 'aac', container: 'm4a' }) ?? 'audio/mp4; codecs="mp4a.40.2"',
}

/**
 * The YouTube codecs playback chooses from, given a browser's `canPlayType`: as
 * `choosePlaybackStream` does with the engine's answers, those the browser is sure of
 * (`probably`), else those it may play (`maybe`). Empty when it plays neither, or doesn't say.
 */
export function youTubeCodecs(canPlayType: (type: string) => string): YouTubeCodec[] {
  const answers = (Object.keys(TYPES) as YouTubeCodec[]).map((codec) => ({
    codec,
    answer: canPlayType(TYPES[codec]),
  }))
  const sure = answers.filter(({ answer }) => answer === 'probably')
  const group = sure.length > 0 ? sure : answers.filter(({ answer }) => answer === 'maybe')
  return group.map(({ codec }) => codec)
}

/** The YouTube codecs this browser plays, asked of an `<audio>` element; empty without a DOM. */
export function browserYouTubeCodecs(): YouTubeCodec[] {
  if (typeof document === 'undefined') return []
  const audio = document.createElement('audio')
  return youTubeCodecs((type) => audio.canPlayType(type))
}
