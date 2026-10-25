import type { Page } from '@playwright/test'

// A saved queue, review list and position for Now playing, so end-to-end tests and screenshots
// show it in use without a stream resolver (stage 2.3) or the network. The app restores them
// from localStorage at start, paused. The songs, artists and lyrics are made up; the artwork is
// inline SVG, so nothing is fetched.

/** Square cover art: a two-colour gradient with a disc, as a data URL. */
function cover(from: string, to: string): { url: string; width: number; height: number }[] {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="60" cy="60" r="28" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3"/><circle cx="60" cy="60" r="5" fill="#fff" fill-opacity=".7"/></svg>`
  return [{ url: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: 544, height: 544 }]
}

function song(videoId: string, title: string, artist: string, durationMs: number, art: string[]) {
  return {
    id: `ytm:track:${videoId}`,
    source: 'ytm',
    title,
    artists: [{ name: artist }],
    durationMs,
    artwork: cover(art[0] ?? '#444', art[1] ?? '#222'),
    kind: 'song',
  }
}

const NEON_HARBOR = {
  id: 'spotify:track:4neonharbor0000000000a',
  source: 'spotify',
  title: 'Neon Harbor',
  artists: [{ name: 'The Midnight Lanterns' }],
  album: { name: 'Late Ferries' },
  durationMs: 213_000,
  artwork: cover('#7c3aed', '#0ea5e9'),
  kind: 'song',
}

const GLASS_TIDES = {
  id: 'spotify:track:4glasstides000000000b',
  source: 'spotify',
  title: 'Glass Tides',
  artists: [{ name: 'Mara Quell' }],
  durationMs: 241_000,
  artwork: cover('#f97316', '#be123c'),
  kind: 'song',
}

function candidate(ref: string, title: string, artist: string, durationMs: number, score: number) {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title,
    artists: [artist],
    durationMs,
    confidence: score,
    evidence: ['title 0.98', `duration ${((durationMs - 213_000) / 1000).toFixed(1)}s`],
  }
}

/** The saved queue: one played song, the current one (matched from Spotify), five up next. */
export const SEED_QUEUE = {
  items: [
    {
      uid: 0,
      track: song('pApErSat001', 'Paper Satellites', 'Juno Vale', 198_000, ['#16a34a', '#0f766e']),
    },
    {
      uid: 1,
      track: NEON_HARBOR,
      candidate: candidate('nEoNhArBoR1', 'Neon Harbor', 'The Midnight Lanterns', 214_000, 0.93),
    },
    {
      uid: 2,
      track: song('sLoWfLaRe02', 'Slow Flare', 'Odessa Rain', 187_000, ['#eab308', '#ea580c']),
    },
    { uid: 3, track: GLASS_TIDES },
    {
      uid: 4,
      track: {
        ...song('cItYoFpInS3', 'City of Pins (Official Video)', 'Kestrel Bloom', 262_000, [
          '#db2777',
          '#7c3aed',
        ]),
        kind: 'music-video',
      },
    },
    {
      uid: 5,
      track: song('wInTeRrAdI4', 'Winter Radio', 'Juno Vale', 205_000, ['#2563eb', '#1e3a8a']),
    },
    {
      uid: 6,
      track: song('hOlLoWsTr05', 'Hollow Street', 'Odessa Rain', 176_000, ['#475569', '#0f172a']),
    },
  ],
  index: 1,
  playedUids: [0],
  context: {
    type: 'playlist',
    id: 'spotify:playlist:latenightdrive00000001',
    title: 'Late night drive',
  },
  mode: 'music',
  repeat: 'off',
  shuffle: false,
  nextUid: 7,
}

/** "Glass Tides" only has a Suggest-band match: it waits for review. */
export const SEED_REVIEW = {
  state: {
    entries: {
      [GLASS_TIDES.id]: candidate('gLaSsTiDeS6', 'Glass Tides (Live)', 'Mara Quell', 247_000, 0.71),
    },
    playBestGuesses: false,
  },
  version: 1,
}

/** Synced lyrics for "Neon Harbor", as LRCLIB answers `/api/get`. */
const LYRICS = {
  id: 1,
  trackName: 'Neon Harbor',
  artistName: 'The Midnight Lanterns',
  albumName: 'Late Ferries',
  duration: 214,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: [
    '[00:00.00]',
    '[00:09.50]Lights on the water, the ferries asleep',
    '[00:16.20]Counting the cranes while the harbour runs deep',
    '[00:23.80]You said the night was a coat we could share',
    '[00:31.00]I wore it home and you were still there',
    '[00:38.40]Oh, neon harbour',
    '[00:42.10]Hold the light a little longer',
    '[00:47.60]Every signal turning amber',
    '[00:53.90]Every engine humming slower',
    '[01:01.20]',
    '[01:08.00]Salt in the static, a song on repeat',
    '[01:15.40]Footsteps in time with the rain on the street',
    '[01:22.70]Oh, neon harbour',
    '[01:26.30]Hold the light a little longer',
  ].join('\n'),
}

/** Where the saved position puts the current song: in the line "Hold the light a little longer". */
export const SEED_POSITION_MS = 45_000

/**
 * Seeds the saved queue, the review list and the position before the app first starts in the
 * tab (a reload keeps what the app saved since), and answers LRCLIB's lookups with made-up
 * synced lyrics.
 */
export async function seedNowPlaying(page: Page): Promise<void> {
  await page.addInitScript(
    ({ queue, review, positionMs }) => {
      if (sessionStorage.getItem('fxm.e2e.seeded') !== null) return
      sessionStorage.setItem('fxm.e2e.seeded', '1')
      localStorage.setItem('fxm.queue.v1', JSON.stringify(queue))
      localStorage.setItem('fxm.queue-review.v1', JSON.stringify(review))
      localStorage.setItem(
        'fxm.playback.v1',
        JSON.stringify({ positionMs, volume: 0.8, muted: false }),
      )
    },
    { queue: SEED_QUEUE, review: SEED_REVIEW, positionMs: SEED_POSITION_MS },
  )
  await page.route('https://lrclib.net/**', (route) =>
    route.fulfill({
      json: LYRICS,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }),
  )
}
