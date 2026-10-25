/**
 * MIME types for streams, as `HTMLMediaElement.canPlayType` expects them.
 *
 * @module
 */

import type { Codec, Container, StreamOption } from '@fxm/core'

/** The `codecs` parameter for each codec inside an ISO BMFF (MP4) container. */
const MP4_CODECS: Partial<Record<Codec, string>> = {
  aac: 'mp4a.40.2',
  alac: 'alac',
  flac: 'flac',
  opus: 'opus',
}

/** Container type and the codecs it can carry, with their `codecs` parameter. */
const TYPES: Readonly<Record<Container, { type: string; codecs: Partial<Record<Codec, string>> }>> =
  {
    webm: { type: 'audio/webm', codecs: { opus: 'opus', vorbis: 'vorbis' } },
    ogg: { type: 'audio/ogg', codecs: { opus: 'opus', vorbis: 'vorbis', flac: 'flac' } },
    mp4: { type: 'audio/mp4', codecs: MP4_CODECS },
    m4a: { type: 'audio/mp4', codecs: MP4_CODECS },
    mp3: { type: 'audio/mpeg', codecs: { mp3: '' } },
    flac: { type: 'audio/flac', codecs: { flac: '' } },
    wav: { type: 'audio/wav', codecs: { pcm: '' } },
  }

/**
 * The MIME type of a stream, e.g. `audio/webm; codecs="opus"` for YouTube's Opus 251 or
 * `audio/mp4; codecs="mp4a.40.2"` for AAC 140. `undefined` for a codec the container can't hold.
 */
export function mimeTypeOf(stream: Pick<StreamOption, 'codec' | 'container'>): string | undefined {
  const entry = Object.hasOwn(TYPES, stream.container) ? TYPES[stream.container] : undefined
  if (entry === undefined || !Object.hasOwn(entry.codecs, stream.codec)) return undefined
  const codecs = entry.codecs[stream.codec]
  return codecs ? `${entry.type}; codecs="${codecs}"` : entry.type
}
