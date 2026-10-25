/**
 * A resolver that answers from a function, recording every request.
 *
 * @module
 */

import type { QueueItem } from '@fxm/core'
import type { ResolvedStream, ResolveRequest, StreamResolver } from '../resolver'
import { testStream } from './fixtures'

/** Answers one resolution: a stream, or a thrown or rejected error. */
export type ResolveHandler = (
  item: QueueItem,
  request: ResolveRequest,
) => ResolvedStream | Promise<ResolvedStream>

/** One request the player made. */
export interface FakeResolverRequest {
  /** The item to resolve. */
  item: QueueItem
  /** The request details. */
  request: ResolveRequest
}

/**
 * A scriptable {@link StreamResolver} for tests. By default every item resolves to
 * `testStream(<track title>)`; replace {@link FakeResolver.handler} to change that.
 */
export class FakeResolver implements StreamResolver {
  /** Every request, in order. */
  readonly requests: FakeResolverRequest[] = []
  /** Answers each request. */
  handler: ResolveHandler

  constructor(handler: ResolveHandler = (item) => ({ stream: testStream(item.track.title) })) {
    this.handler = handler
  }

  async resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream> {
    this.requests.push({ item, request })
    return this.handler(item, request)
  }

  /** The requests for the track titled `title`. */
  requestsFor(title: string): ResolveRequest[] {
    return this.requests.flatMap(({ item, request }) =>
      item.track.title === title ? [request] : [],
    )
  }
}
