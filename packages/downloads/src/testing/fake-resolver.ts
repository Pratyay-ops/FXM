/**
 * A download resolver that resolves nothing real: it answers from a handler a test sets, and
 * records every call.
 *
 * @module
 */

import {
  type AudioCandidate,
  type Codec,
  type Container,
  ownCandidate,
  type StreamOption,
  type Track,
} from '@fxm/core'
import type { DownloadResolveRequest, DownloadResolver, ResolvedDownload } from '../resolver'

/** One call to {@link FakeDownloadResolver.resolve}. */
export interface FakeDownloadResolverCall {
  /** The track. */
  track: Track
  /** The request. */
  request: DownloadResolveRequest
}

/** Answers one call. */
export type DownloadResolveHandler = (
  track: Track,
  request: DownloadResolveRequest,
  call: number,
) => Promise<ResolvedDownload> | ResolvedDownload

/**
 * A verified, progressive Opus stream at `url`, bound to the IP like YouTube's: what the
 * YouTube ladder (1.4) hands out where bytes are readable.
 */
export function downloadStream(url: string, overrides: Partial<StreamOption> = {}): StreamOption {
  return {
    url,
    codec: 'opus' satisfies Codec,
    container: 'webm' satisfies Container,
    media: 'audio',
    bitrateKbps: 150,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'verified',
    ...overrides,
  }
}

/** `track`'s own audio as a candidate, e.g. a YouTube Music song's video. */
export function downloadCandidate(track: Track): AudioCandidate {
  const candidate = ownCandidate(track)
  if (candidate === undefined) throw new Error(`${track.id} has no audio of its own`)
  return candidate
}

/**
 * A scriptable {@link DownloadResolver}. By default it resolves every track to its own audio at
 * `https://media.test/<nativeId>?n=<call>` (a fresh URL per call, like YouTube's signed URLs);
 * set {@link FakeDownloadResolver.handler} to answer otherwise, or throw from it to fail.
 */
export class FakeDownloadResolver implements DownloadResolver {
  /** Every call, in order. */
  readonly calls: FakeDownloadResolverCall[] = []
  /** Answers each call. */
  handler: DownloadResolveHandler

  constructor(handler?: DownloadResolveHandler) {
    this.handler =
      handler ??
      ((track, _request, call) => {
        const candidate = downloadCandidate(track)
        return {
          candidate,
          stream: downloadStream(
            `https://media.test/${encodeURIComponent(candidate.ref)}?n=${call}`,
          ),
        }
      })
  }

  async resolve(track: Track, request: DownloadResolveRequest): Promise<ResolvedDownload> {
    this.calls.push({ track, request })
    return this.handler(track, request, this.calls.length)
  }

  /** The reasons of the calls for `track`, in order, e.g. `['start', 'refresh']`. */
  reasonsFor(track: Track): string[] {
    return this.calls
      .filter((call) => call.track.id === track.id)
      .map((call) => call.request.reason)
  }
}
