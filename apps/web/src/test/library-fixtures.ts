import { formatId, type Track } from '@fxm/core'
import { openDatabase } from '../db/database'
import { createLibraryRepo, type RepoDeps } from '../db/repo'

/** A YouTube Music song named after `n`, e.g. `track(1)` is "Song 1" by "Artist 1". */
export function track(n: number, overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', `video${String(n).padStart(4, '0')}`),
    source: 'ytm',
    title: `Song ${n}`,
    artists: [{ name: `Artist ${n}` }],
    album: { name: `Album ${n}` },
    durationMs: 180_000 + n * 1000,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}

/** `count` songs, `track(1)` to `track(count)`. */
export function tracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => track(index + 1))
}

let databases = 0

/**
 * A repository on a database of its own, with a clock that moves one second per call (so
 * every timestamp differs), unless `deps` says otherwise.
 */
export function testRepo(deps: Partial<RepoDeps> = {}) {
  let clock = Date.UTC(2026, 9, 25, 12)
  databases++
  return createLibraryRepo(openDatabase(`fxm-test-${databases}-${Math.random()}`), {
    now: () => {
      clock += 1000
      return clock
    },
    ...deps,
  })
}
