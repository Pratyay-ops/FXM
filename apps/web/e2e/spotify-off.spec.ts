import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

// With Spotify switched off, FXM contacts no Spotify host, its image servers included: Settings
// says "Off: FXM doesn't contact Spotify." The library here holds what an import or the Spotify
// account sync leaves behind (made-up songs with Spotify-hosted covers: a song cover on i.scdn.co,
// a playlist mosaic on mosaic.scdn.co, a playlist image on a spotifycdn.com host, a liked copy
// without artwork of its own, a followed artist's photo). Every request to Spotify's image hosts
// is answered here with a pixel and counted: none may be made while the switch is off.

const LIBRARY_BACKUP = fileURLToPath(new URL('./fixtures/library-backup.json', import.meta.url))
const SPOTIFY_IMAGES = /^https:\/\/([^/]+\.)?(scdn\.co|spotifycdn\.com)\//
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const LIKED_COPY = 'local:playlist:spotify-liked-e2e'
const MOSAIC_COPY = 'local:playlist:spotify-37i9dQZF1DXcBWIGoYBM5M'

interface Backup {
  tables: Record<string, Record<string, unknown>[]>
}

/** The fixture library plus Spotify songs, copies and a follow with Spotify-hosted images. */
function spotifyLibrary(): Buffer {
  const backup = JSON.parse(readFileSync(LIBRARY_BACKUP, 'utf8')) as Backup
  const at = 1761400000000
  const song = (n: number) => {
    const id = `spotify:track:fxmSpotifyE2E${String(n).padStart(9, '0')}`
    return {
      id,
      track: {
        id,
        source: 'spotify',
        title: `Spotify song ${n}`,
        artists: [{ name: 'Spotify Artist' }],
        album: { name: 'Spotify Album' },
        durationMs: 200000,
        artwork: [
          { url: `https://i.scdn.co/image/ab67616d0000b273e2e${n}`, width: 640, height: 640 },
          { url: `https://i.scdn.co/image/ab67616d00001e02e2e${n}`, width: 300, height: 300 },
        ],
        kind: 'song',
      },
      updatedAt: at + n,
    }
  }
  const songs = [song(1), song(2), song(3)]
  backup.tables.tracks?.push(...songs)
  const ids = songs.map((one) => one.id)
  backup.tables.playlists?.push(
    // The liked songs' copy has no artwork of its own: lists show its first song's cover.
    {
      id: LIKED_COPY,
      name: 'Liked songs on Spotify',
      createdAt: at,
      updatedAt: at,
      trackIds: ids,
      addedAt: {},
    },
    {
      id: MOSAIC_COPY,
      name: 'Today’s Top Hits',
      createdAt: at,
      updatedAt: at,
      trackIds: ids.slice(1),
      addedAt: {},
      artwork: [
        { url: 'https://mosaic.scdn.co/640/ab67616d0000b273e2e1', width: 640, height: 640 },
      ],
    },
    {
      id: 'local:playlist:spotify-37i9dQZF1E4e2e',
      name: 'Daily Mix 1',
      createdAt: at,
      updatedAt: at,
      trackIds: ids.slice(2),
      addedAt: {},
      artwork: [{ url: 'https://dailymix-images.scdn.co/v2/img/e2e/en/default' }],
    },
    {
      id: 'local:playlist:spotify-37i9dQZF1DZ06e2e',
      name: 'This Is Spotify Artist',
      createdAt: at,
      updatedAt: at,
      trackIds: ids,
      addedAt: {},
      artwork: [{ url: 'https://thisis-images.spotifycdn.com/37i9dQZF1DZ06e2e-default.jpg' }],
    },
  )
  backup.tables.follows?.push({
    key: 'spotify:artist:fxmSpotifyArtistE2E',
    id: 'spotify:artist:fxmSpotifyArtistE2E',
    kind: 'artist',
    name: 'Spotify Artist',
    artwork: [{ url: 'https://i.scdn.co/image/ab6761610000e5ebe2e', width: 640, height: 640 }],
    followedAt: at,
  })
  return Buffer.from(JSON.stringify(backup))
}

/** Restores the library above through the Backup dialog, replacing what is there. */
async function restoreLibrary(page: Page) {
  await page.goto('library')
  await page.getByRole('main').getByRole('button', { name: 'Backup' }).click()
  const dialog = page.getByRole('dialog', { name: 'Back up your library' })
  await dialog.getByLabel('Choose a backup file').setInputFiles({
    name: 'spotify-library.json',
    mimeType: 'application/json',
    buffer: spotifyLibrary(),
  })
  await dialog.getByRole('radio', { name: /Replace/ }).check()
  await dialog.getByRole('button', { name: 'Replace my library' }).click()
  await expect(page.getByText('Library replaced from the backup')).toBeVisible()
}

/** Sets Settings → Sources → Spotify to `value`, as a user would. */
async function setSpotify(page: Page, value: 'On' | 'Off') {
  await page.goto('settings')
  await page
    .getByRole('radiogroup', { name: 'Spotify' })
    .locator('label', { hasText: new RegExp(`^${value}$`) })
    .click()
  await expect(page.getByRole('radio', { name: value })).toBeChecked()
  if (value === 'Off') {
    await expect(page.getByText("Off: FXM doesn't contact Spotify.")).toBeVisible()
  }
}

/** Opens each page that shows the library's covers, and waits for its images to settle. */
async function browse(page: Page) {
  for (const path of [
    './',
    'library',
    'library?tab=playlists',
    'library?tab=artists',
    `playlist/${LIKED_COPY}`,
    `playlist/${MOSAIC_COPY}`,
    'settings',
  ]) {
    await page.goto(path)
    await expect(page.getByRole('main')).toBeVisible()
    await page.waitForLoadState('networkidle')
  }
}

test('loads no image from Spotify while Spotify is switched off', async ({ page }) => {
  const spotify: string[] = []
  await page.route(SPOTIFY_IMAGES, (route) => {
    spotify.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
  })

  await setSpotify(page, 'Off')
  await restoreLibrary(page)
  // The copies are there: the sidebar lists them, with placeholders for their covers.
  const sidebar = page.getByRole('list', { name: 'Your playlists' })
  await expect(sidebar.getByRole('link', { name: 'Liked songs on Spotify' })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: 'Today’s Top Hits' })).toBeVisible()
  await browse(page)
  expect(spotify).toEqual([])

  // Switched on, the same pages load Spotify's covers: the check above could see them.
  await setSpotify(page, 'On')
  await browse(page)
  expect(spotify.length).toBeGreaterThan(0)
  expect(spotify.some((url) => url.startsWith('https://mosaic.scdn.co/'))).toBe(true)
})
