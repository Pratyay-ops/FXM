/**
 * Test data: tracks and streams with predictable values. The URLs use the reserved `.test`
 * domain, so nothing can reach the network by accident.
 *
 * @module
 */

import { formatId, type StreamOption, type Track } from '@fxm/core'

/** A YouTube Music song titled `name`, three minutes long. */
export function testTrack(name: string, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', name),
    source: 'ytm',
    title: name,
    artists: [{ name: `${name} artist` }],
    artwork: [],
    kind: 'song',
    durationMs: 180_000,
    ...overrides,
  }
}

/** One {@link testTrack} per name. */
export function testTracks(...names: string[]): Track[] {
  return names.map((name) => testTrack(name))
}

/**
 * A progressive, audio-only Opus stream at `https://media.test/<name>`, not probed for its full
 * length (`fullLength` `unverified`).
 */
export function testStream(name: string, overrides: Partial<StreamOption> = {}): StreamOption {
  return {
    url: `https://media.test/${encodeURIComponent(name)}`,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 160,
    tier: 'high',
    protocol: 'progressive',
    ipBound: false,
    fullLength: 'unverified',
    ...overrides,
  }
}
