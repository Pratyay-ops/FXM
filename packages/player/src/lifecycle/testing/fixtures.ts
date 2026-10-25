/**
 * Test data for the stream lifecycle: candidates, tracks from a catalog without audio, and
 * provider contexts for each tier. Nothing here touches the network.
 *
 * @module
 */

import {
  type AudioCandidate,
  formatId,
  type NetworkCapabilities,
  type ProviderContext,
  type Track,
} from '@fxm/core'

/** A YouTube Music song candidate for the video `ref`, a confident match. */
export function testCandidate(
  ref: string,
  overrides: Partial<AudioCandidate> = {},
): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: ref,
    artists: [`${ref} artist`],
    durationMs: 180_000,
    confidence: 0.95,
    evidence: ['test'],
    ...overrides,
  }
}

/** A Spotify track titled `name`, which has no audio of its own and must be matched to a song. */
export function testSpotifyTrack(name: string, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('spotify', 'track', name),
    source: 'spotify',
    title: name,
    artists: [{ name: `${name} artist` }],
    artwork: [],
    kind: 'song',
    durationMs: 180_000,
    ...overrides,
  }
}

/** The tiers, by what they let the providers reach. */
export const TEST_CAPABILITIES = Object.freeze({
  /** The web app without FXM Connect or Lite: free sources only. */
  free: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  /** The experimental Lite tier: YouTube through the sandbox, media bytes unreadable. */
  lite: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  /** FXM Connect, the desktop app or the Android app: everything, bytes included. */
  full: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
} satisfies Record<string, NetworkCapabilities>)

/**
 * A provider context for a tier. Its `fetch` rejects every call, so a test that reaches the
 * network by mistake fails at once.
 */
export function testContext(
  tier: keyof typeof TEST_CAPABILITIES = 'full',
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  return {
    fetch: async () => {
      throw new Error('The tests never reach the network')
    },
    platform: 'web',
    capabilities: TEST_CAPABILITIES[tier],
    mode: 'music',
    ...overrides,
  }
}
