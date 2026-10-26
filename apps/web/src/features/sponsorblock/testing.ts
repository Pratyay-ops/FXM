/**
 * Test helpers for SponsorBlock skipping: a fake client that answers from a function, and test
 * data. Nothing here touches the network.
 *
 * @module
 */

import { formatId, type ProviderContext, type Track } from '@fxm/core'
import { testTrack } from '@fxm/player/testing'
import type { SponsorBlockClient, SponsorBlockSegment } from '@fxm/sources/sponsorblock'
import { setSponsorBlockClient } from './sponsorblock-source'

/** A SponsorBlock client that answers from `handler` and records every lookup. */
export interface FakeSponsorBlock extends SponsorBlockClient {
  /** The videoIds looked up, in order. */
  readonly lookups: string[]
  /** The contexts of the lookups, in order. */
  readonly contexts: ProviderContext[]
  handler: (
    videoId: string,
    ctx: ProviderContext,
  ) => SponsorBlockSegment[] | Promise<SponsorBlockSegment[]>
}

/**
 * Makes the app's SponsorBlock lookups go to a fake; the test setup puts the real client back
 * after each test.
 */
export function setupTestSponsorBlock(
  handler: FakeSponsorBlock['handler'] = () => [],
): FakeSponsorBlock {
  const client: FakeSponsorBlock = {
    lookups: [],
    contexts: [],
    handler,
    async nonMusicSegments(videoId, ctx) {
      client.lookups.push(videoId)
      client.contexts.push(ctx)
      return client.handler(videoId, ctx)
    },
  }
  setSponsorBlockClient(client)
  return client
}

/** An official music video from YouTube Music, three minutes long, with `videoId` as its ID. */
export function testVideo(videoId: string, overrides: Partial<Track> = {}): Track {
  return testTrack(videoId, {
    id: formatId('ytm', 'track', videoId),
    title: `${videoId} (Official Video)`,
    kind: 'music-video',
    ...overrides,
  })
}

/** A segment from `startS` to `endS` seconds, marked on a three-minute video. */
export function testSegment(startS: number, endS: number): SponsorBlockSegment {
  return { startMs: startS * 1000, endMs: endS * 1000, videoDurationMs: 180_000 }
}
