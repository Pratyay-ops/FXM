/**
 * The content the browser tests embed, shared by the test-double build of the embed
 * (`e2e-services.ts`) and the tests themselves (`e2e/embed`), so both agree on IDs, titles and
 * media hosts. Plain data, no DOM: the tests import it in Node.
 *
 * @module
 */

/** The host the test network serves YouTube's media from. */
export const E2E_MEDIA_HOST = 'rr1---sn-fxm-e2e.googlevideo.com'

/** The host the test network serves Internet Archive's files from. */
export const E2E_ARCHIVE_HOST = 'ia800000.us.archive.org'

/** One YouTube Music song of the fixtures. */
export interface E2eSong {
  readonly videoId: string
  readonly title: string
  readonly artist: string
  readonly durationMs: number
}

/** The songs, by name: `lite` is the single track the done-when test plays. */
export const E2E_SONGS = {
  lite: {
    videoId: 'fxmLiteSng1',
    title: 'Opaque Origin',
    artist: 'The Sandboxes',
    durationMs: 35_000,
  },
  second: {
    videoId: 'fxmLiteSng2',
    title: 'Simple Request',
    artist: 'The Sandboxes',
    durationMs: 35_000,
  },
  third: {
    videoId: 'fxmLiteSng3',
    title: 'No Preflight',
    artist: 'The Sandboxes',
    durationMs: 35_000,
  },
} as const satisfies Record<string, E2eSong>

/** The album: the three songs, from its audio playlist. */
export const E2E_ALBUM = {
  browseId: 'MPREb_fxmE2E',
  name: 'Null Origin Sessions',
  artist: 'The Sandboxes',
  songs: [E2E_SONGS.lite, E2E_SONGS.second, E2E_SONGS.third],
} as const

/** The playlist: two of the songs. */
export const E2E_PLAYLIST = {
  playlistId: 'PLfxmE2Eplaylist',
  name: 'Embedded Everywhere',
  owner: 'FXM tests',
  songs: [E2E_SONGS.second, E2E_SONGS.third],
} as const

/** An official music video without a song link: hidden in Music mode, plays in Music + Video. */
export const E2E_VIDEO = {
  videoId: 'fxmLiteVid1',
  title: 'Opaque Origin (Official Video)',
  artist: 'The Sandboxes',
  durationMs: 35_000,
} as const satisfies E2eSong

/** A free Internet Archive track, which plays on every tier. */
export const E2E_ARCHIVE_TRACK = {
  identifier: 'fxm-e2e-item',
  file: 'silence.wav',
  title: 'Public Domain Silence',
  artist: 'Archive Ensemble',
  durationMs: 35_000,
} as const

/** The Internet Archive track's native ID: `<identifier>/<file>`. */
export const E2E_ARCHIVE_NATIVE_ID = `${E2E_ARCHIVE_TRACK.identifier}/${E2E_ARCHIVE_TRACK.file}`
