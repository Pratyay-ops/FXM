/**
 * The audio of a SABR session, as a stream of bytes: googlevideo's `SabrStream` (MIT) posts the
 * session's protobuf requests to the server ABR streaming URL through the given `fetch`, reads
 * the UMP answers, follows the server's redirects, context updates and back-off, and hands out the
 * audio format's initialization segment and media segments in order. The session is audio only:
 * it tells the server it holds all of the video format, so none is sent.
 *
 * `SabrStream` downloads the whole song as fast as the server lets it (a few megabytes for a
 * song); the engine appends to its source buffer at its own pace.
 *
 * @module
 */

import { SabrStream } from 'googlevideo/sabr-stream'
import { EnabledTrackTypes } from 'googlevideo/utils'
import type { SabrPlayback } from './sabr-playback'

/**
 * How often a failed request is tried again (after 0.5, 1 and 2 s) before the session fails.
 * googlevideo's default, 10 with waits of up to 8 s, would keep the player silent for about a
 * minute before it could fall back.
 */
export const SABR_MAX_RETRIES = 3

/** A running session's audio. */
export interface SabrFeed {
  /** The audio format's bytes: its initialization segment, then its media segments. */
  readonly audio: ReadableStream<Uint8Array>
  /** Stops the session; `audio` then errors. */
  abort(): void
}

/** Starts a SABR feed; {@link startSabrFeed} by default, a fake in tests. */
export type SabrFeedStarter = (
  playback: SabrPlayback,
  url: string,
  fetch: typeof globalThis.fetch,
) => Promise<SabrFeed>

/**
 * Starts the session of `playback` at `url` (the server ABR streaming URL, its `n` deciphered),
 * with `fetch` for its requests: FXM Connect's page `fetch` on the web, the native one on desktop.
 */
export const startSabrFeed: SabrFeedStarter = async (playback, url, fetch) => {
  const stream = new SabrStream({
    fetch,
    serverAbrStreamingUrl: url,
    videoPlaybackUstreamerConfig: playback.ustreamerConfig,
    poToken: playback.poToken,
    clientInfo: { clientName: playback.client.nameId, clientVersion: playback.client.version },
    durationMs: playback.durationMs,
    formats: [playback.audio, playback.video],
  })
  const { audioStream } = await stream.start({
    audioFormat: playback.audio,
    videoFormat: playback.video,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    maxRetries: SABR_MAX_RETRIES,
  })
  return { audio: audioStream, abort: () => stream.abort() }
}
